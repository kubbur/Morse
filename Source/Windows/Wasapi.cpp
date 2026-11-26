#include "Wasapi.h"
#include <audioclient.h>
#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmreg.h>
#include <propsys.h>
#include <algorithm>
#include <array>
#include <memory>

using winrt::check_hresult;
using winrt::com_ptr;

static std::wstring endpointID(IMMDevice *device) {
    LPWSTR raw=nullptr;
    check_hresult(device->GetId(&raw));
    std::unique_ptr<wchar_t,decltype(&CoTaskMemFree)> id(raw,CoTaskMemFree);
    return id.get();
}
static std::vector<Endpoint> endpoints(IMMDeviceEnumerator *enumerator, EDataFlow flow) {
    com_ptr<IMMDeviceCollection> devices;
    check_hresult(enumerator->EnumAudioEndpoints(flow,DEVICE_STATE_ACTIVE,devices.put()));
    UINT count=0; check_hresult(devices->GetCount(&count));
    std::vector<Endpoint> list;
    for (UINT i=0;i<count;i++) {
        com_ptr<IMMDevice> device; com_ptr<IPropertyStore> props;
        if (FAILED(devices->Item(i,device.put())) || FAILED(device->OpenPropertyStore(STGM_READ,props.put()))) continue;
        PROPVARIANT name{};
        if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName,&name)) && name.vt==VT_LPWSTR && name.pwszVal)
            list.push_back({endpointID(device.get()),name.pwszVal});
        PropVariantClear(&name);
    }
    return list;
}
Devices listDevices(IMMDeviceEnumerator *enumerator) {
    Devices list{endpoints(enumerator,eRender),endpoints(enumerator,eCapture),{}};
    com_ptr<IMMDevice> output;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender,eConsole,output.put()))) list.defaultOutput=endpointID(output.get());
    return list;
}

struct Stream {
    com_ptr<IAudioClient> client;
    com_ptr<IAudioCaptureClient> capture;
    com_ptr<IAudioRenderClient> render;
    winrt::handle event;
    UINT32 capacity=0;
    ULONGLONG lastProgress=0;
    bool captured=false;
    void open(IMMDeviceEnumerator *devices, const std::wstring& id, bool mic, bool pilots) {
        com_ptr<IMMDevice> device; check_hresult(devices->GetDevice(id.c_str(),device.put()));
        check_hresult(device->Activate(__uuidof(IAudioClient),CLSCTX_ALL,nullptr,client.put_void()));
        WAVEFORMATEX *raw=nullptr; check_hresult(client->GetMixFormat(&raw));
        std::unique_ptr<WAVEFORMATEX,decltype(&CoTaskMemFree)> mix(raw,CoTaskMemFree);
        if (pilots && mix->nChannels<2) throw winrt::hresult_error(AUDCLNT_E_UNSUPPORTED_FORMAT);
        WORD channels=mic ? 1 : 2;
        WAVEFORMATEX format{WAVE_FORMAT_IEEE_FLOAT,channels,48000,48000u*channels*4u,WORD(channels*4),32,0};
        // Shared mode lets Windows resample common 44.1/48 kHz headset endpoints.
        // A zero duration requests the engine's smallest ordinary shared buffer.
        DWORD flags=AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        check_hresult(client->Initialize(AUDCLNT_SHAREMODE_SHARED,flags,0,0,&format,nullptr));
        event.attach(CreateEventW(nullptr,FALSE,FALSE,nullptr)); winrt::check_bool(bool(event));
        check_hresult(client->SetEventHandle(event.get())); check_hresult(client->GetBufferSize(&capacity));
        if (mic) check_hresult(client->GetService(__uuidof(IAudioCaptureClient),capture.put_void()));
        else check_hresult(client->GetService(__uuidof(IAudioRenderClient),render.put_void()));
    }
    ~Stream() { if (client) client->Stop(); }
};

AudioRoute::AudioRoute(std::wstring pilot,std::wstring mic,std::wstring speaker,unsigned epoch,
                       const ConverterSettings& settings,const ConverterProfile& profile)
    : stopEvent(CreateEventW(nullptr,TRUE,FALSE,nullptr)), core(nullptr) {
    winrt::check_bool(bool(stopEvent));
    core=converterCreate(epoch,&settings,&profile);
    if (!core) throw std::bad_alloc();
    try { worker=std::thread(&AudioRoute::run,this,std::move(pilot),std::move(mic),std::move(speaker)); }
    catch (...) { converterDestroy(core); throw; }
}
AudioRoute::~AudioRoute() {
    SetEvent(stopEvent.get());
    if (worker.joinable()) worker.join();
    converterDestroy(core);
}
void AudioRoute::run(const std::wstring& pilot,const std::wstring& mic,const std::wstring& speaker) {
    try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        struct Apartment { ~Apartment() { winrt::uninit_apartment(); } } apartment;
        auto devices=winrt::create_instance<IMMDeviceEnumerator>(__uuidof(MMDeviceEnumerator));
        Stream capture,pilots,audible;
        if (!mic.empty()) capture.open(devices.get(),mic,true,false);
        if (!pilot.empty()) pilots.open(devices.get(),pilot,false,true);
        if (!speaker.empty()) audible.open(devices.get(),speaker,false,false);
        std::array<float,512> mono{};
        auto render=[&](Stream& stream,bool drive) {
            UINT32 padding=0; check_hresult(stream.client->GetCurrentPadding(&padding));
            if (padding>=stream.capacity) return;
            UINT32 frames=stream.capacity-padding;
            BYTE *raw=nullptr; check_hresult(stream.render->GetBuffer(frames,&raw));
            auto *pcm=reinterpret_cast<float*>(raw);
            for (UINT32 offset=0;offset<frames;) {
                UINT32 count=std::min<UINT32>(UINT32(mono.size()),frames-offset);
                std::lock_guard lock(mutex);
                if (drive) {
                    converterPilots(core,pcm+2*offset,count);
                    // When Windows exposes only the headset, the pilot clock still
                    // drives the scorer without mixing sidetone into the return.
                    if (!audible.client) converterSpeaker(core,mono.data(),count);
                } else {
                    converterSpeaker(core,mono.data(),count);
                    for (UINT32 i=0;i<count;i++) pcm[2*(offset+i)]=pcm[2*(offset+i)+1]=mono[i];
                }
                offset+=count;
            }
            check_hresult(stream.render->ReleaseBuffer(frames,0)); stream.lastProgress=GetTickCount64();
        };
        const std::array<float,512> silence{};
        auto readMic=[&]() {
            UINT32 packet=0; check_hresult(capture.capture->GetNextPacketSize(&packet));
            while (packet) {
                BYTE *raw=nullptr; DWORD flags=0; UINT32 n=0;
                check_hresult(capture.capture->GetBuffer(&raw,&n,&flags,nullptr,nullptr));
                // Windows may flag the first capture packet on a healthy new stream.
                if ((flags&AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) && capture.captured) {
                    std::lock_guard lock(mutex); converterInterrupt(core);
                }
                for (UINT32 i=0;i<n;) {
                    UINT32 count=std::min<UINT32>(UINT32(silence.size()),n-i);
                    const float *data=(flags&AUDCLNT_BUFFERFLAGS_SILENT) ? silence.data() : reinterpret_cast<float*>(raw)+i;
                    std::lock_guard lock(mutex); converterInput(core,data,count); i+=count;
                }
                check_hresult(capture.capture->ReleaseBuffer(n));
                capture.captured=true; capture.lastProgress=GetTickCount64();
                check_hresult(capture.capture->GetNextPacketSize(&packet));
            }
        };
        DWORD task=0;
        struct Priority { HANDLE handle; ~Priority() { if (handle) AvRevertMmThreadCharacteristics(handle); } };
        Priority priority{AvSetMmThreadCharacteristicsW(L"Audio",&task)};
        std::vector<HANDLE> handles{stopEvent.get()};
        for (Stream *s : {&capture,&pilots,&audible}) if (s->client) {
            handles.push_back(s->event.get());
            if (s->render) render(*s,s==&pilots);
            check_hresult(s->client->Start()); s->lastProgress=GetTickCount64();
        }
        result=S_OK;
        for (;;) {
            DWORD wait=WaitForMultipleObjects(DWORD(handles.size()),handles.data(),FALSE,500);
            if (wait==WAIT_OBJECT_0) return;
            if (wait==WAIT_FAILED) winrt::throw_last_error();
            if (capture.client) readMic();
            if (pilots.client) render(pilots,true);
            if (audible.client) render(audible,false);
            auto now=GetTickCount64();
            for (Stream *s : {&capture,&pilots,&audible})
                if (s->client && now-s->lastProgress>2000) throw winrt::hresult_error(AUDCLNT_E_DEVICE_INVALIDATED);
        }
    } catch (...) { result=winrt::to_hresult(); }
}
