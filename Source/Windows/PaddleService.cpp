#include "Wasapi.h"
#include <audioclient.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <deque>

using namespace winrt::Windows::Data::Json;
using Json=JsonObject;
using std::wstring;
namespace fs=std::filesystem;
static void str(const Json& j,const wchar_t *key,const wstring& value) { j.Insert(key,JsonValue::CreateStringValue(value)); }
static void num(const Json& j,const wchar_t *key,double value) { j.Insert(key,JsonValue::CreateNumberValue(value)); }
static void flag(const Json& j,const wchar_t *key,bool value) { j.Insert(key,JsonValue::CreateBooleanValue(value)); }
static void emit(const Json& j) { std::cout<<winrt::to_string(j.Stringify())<<'\n'<<std::flush; }
static Json error(const wstring& message) { Json j; str(j,L"error",message); return j; }
static wstring idName(const std::vector<Endpoint>& devices,const wstring& id) {
    for (const auto& device:devices) if (device.id==id) return device.name;
    return {};
}
static JsonArray choices(const std::vector<Endpoint>& devices) {
    JsonArray a;
    for (const auto& device:devices) { Json d; str(d,L"id",device.id); str(d,L"name",device.name); a.Append(d); }
    return a;
}

class Host {
    fs::path file;
    Json prefs;
    winrt::com_ptr<IMMDeviceEnumerator> enumerator;
    Devices devices;
    std::unique_ptr<AudioRoute> route;
    wstring source=L"off",pilot,mic,output,activePilot,activeMic,activeSpeaker,reason,saveIssue;
    ConverterSettings settings{30,30,650,65,2,2,0,false,false,false};
    ConverterState state{};
    unsigned epoch=1;
    uint64_t sequence=0,nextScan=0,retry=0;
    DWORD parent;
    HWND target=nullptr;
    bool isolated,typing=false,muted=false,ready=false,dirty=true;

    void save() {
        fs::path temp=file; temp+=L".tmp";
        std::ofstream stream(temp,std::ios::binary|std::ios::trunc);
        stream<<winrt::to_string(prefs.Stringify()); stream.close();
        saveIssue=stream && MoveFileExW(temp.c_str(),file.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)
            ? L"" : L"Could not save paddle preferences to this Windows profile.";
    }
    wstring profileKey() const { return pilot+L"|"+mic; }
    Json profiles() {
        if (!prefs.HasKey(L"profiles")) prefs.Insert(L"profiles",Json{});
        return prefs.GetNamedObject(L"profiles");
    }
    ConverterProfile profile() {
        ConverterProfile result{}; auto all=profiles();
        if (!all.HasKey(profileKey())) return result;
        auto j=all.GetNamedObject(profileKey());
        result.on[0]=j.GetNamedNumber(L"onL"); result.on[1]=j.GetNamedNumber(L"onR");
        result.off[0]=j.GetNamedNumber(L"offL"); result.off[1]=j.GetNamedNumber(L"offR");
        result.boosted=j.GetNamedBoolean(L"boosted",false); return result;
    }
    void keepProfile(const ConverterProfile& p) {
        Json j; num(j,L"onL",p.on[0]); num(j,L"onR",p.on[1]); num(j,L"offL",p.off[0]); num(j,L"offR",p.off[1]);
        flag(j,L"boosted",p.boosted); profiles().Insert(profileKey(),j); save();
    }
    void resetEvent() { Json j; str(j,L"type",L"reset"); num(j,L"epoch",epoch); emit(j); dirty=true; }
    void disarm() {
        typing=false; target=nullptr;
        if (route) { std::lock_guard lock(route->mutex); converterTarget(route->core,0); }
    }
    void interrupt() {
        disarm(); muted=false;
        if (route) {
            std::lock_guard lock(route->mutex); converterMute(route->core,false); converterInterrupt(route->core);
            epoch=converterState(route->core).epoch;
        } else ++epoch;
        resetEvent();
    }
    void stop() {
        disarm(); route.reset(); activePilot.clear(); activeMic.clear(); activeSpeaker.clear();
        ready=false; muted=false; state={}; ++epoch; resetEvent();
    }
    void scan() {
        try {
            if (!enumerator) enumerator=winrt::create_instance<IMMDeviceEnumerator>(__uuidof(MMDeviceEnumerator));
            auto list=listDevices(enumerator.get());
            auto equal=[](const auto& a,const auto& b) {
                if (a.size()!=b.size()) return false;
                for (size_t i=0;i<a.size();i++) if (a[i].id!=b[i].id || a[i].name!=b[i].name) return false;
                return true;
            };
            if (!equal(list.outputs,devices.outputs) || !equal(list.inputs,devices.inputs) || list.defaultOutput!=devices.defaultOutput) {
                devices=std::move(list); dirty=true; retry=0;
            }
        } catch (const winrt::hresult_error&) { devices={}; enumerator=nullptr; dirty=true; }
        nextScan=GetTickCount64()+1500;
    }
    void reconcile() {
        wstring p,m,s,problem;
        if (source==L"off") problem=L"Hardware paddle input is off.";
        else {
            s=output==L"auto" ? devices.defaultOutput : output;
            if (source==L"paddle") {
                p=pilot; m=mic;
                if (p.empty() || m.empty()) problem=L"Select the converter headphones and headset microphone in Settings.";
                else if (idName(devices.outputs,p).empty() || idName(devices.inputs,m).empty())
                    problem=L"The selected converter is disconnected. Reconnect it or choose its devices in Settings.";
                if (s==p || s==L"silent" || (output==L"auto" && s.empty())) s.clear();
            }
            if (problem.empty() && ((s.empty() && source==L"vband") || (!s.empty() && idName(devices.outputs,s).empty())))
                problem=L"Select an available sidetone output in Settings.";
        }
        if (route && (!problem.empty() || p!=activePilot || m!=activeMic || s!=activeSpeaker)) stop();
        if (!problem.empty()) { if (reason!=problem) { reason=problem; dirty=true; } return; }
        if (route || GetTickCount64()<retry) return;
        activePilot=p; activeMic=m; activeSpeaker=s; reason=L"Opening Windows audio devices."; dirty=true;
        route=std::make_unique<AudioRoute>(p,m,s,++epoch,settings,source==L"paddle" ? profile() : ConverterProfile{});
        resetEvent();
    }
    bool canArm() const { return !isolated && ready && source==L"paddle" && !state.sampling; }
    void status() {
        Json j; str(j,L"type",L"status"); str(j,L"source",source); num(j,L"epoch",epoch);
        str(j,L"phase",ready ? L"ready" : L"waiting"); str(j,L"detail",reason);
        j.Insert(L"outputs",choices(devices.outputs)); j.Insert(L"inputs",choices(devices.inputs));
        str(j,L"pilot",pilot); str(j,L"mic",mic); str(j,L"output",output);
        str(j,L"playing",route && route->result==S_OK ? activeSpeaker.empty()
            ? L"Silent practice. Select a separate speaker to hear sidetone." : L"Output: "+idName(devices.outputs,activeSpeaker) : L"");
        flag(j,L"outputReady",route && route->result==S_OK); flag(j,L"audible",route && route->result==S_OK && !activeSpeaker.empty()); num(j,L"volume",settings.volume);
        flag(j,L"reverse",settings.reverse); flag(j,L"hasReverse",prefs.HasKey(L"reverse"));
        num(j,L"pitch",settings.pitch); num(j,L"rise",settings.rise); num(j,L"fall",settings.fall); num(j,L"curve",settings.curve);
        num(j,L"wpm",settings.wpm); num(j,L"spacing",settings.spacing); flag(j,L"wordSpaces",settings.spaces);
        flag(j,L"sharedSound",true); flag(j,L"hasTone",false); flag(j,L"hasVolume",false); num(j,L"legacyWpm",0);
        num(j,L"calibration",state.calibration); flag(j,L"sampling",state.sampling); num(j,L"mask",state.mask);
        flag(j,L"typing",typing); flag(j,L"canArm",canArm()); str(j,L"typingIssue",saveIssue);
        dirty=false; emit(j);
    }
    void focus() {
        if (!typing || !route) return;
        HWND front=GetForegroundWindow(); DWORD pid=0;
        if (front) GetWindowThreadProcessId(front,&pid);
        if (!pid || pid==parent || pid==GetCurrentProcessId()) { front=nullptr; pid=0; }
        if (front!=target) {
            target=front; std::lock_guard lock(route->mutex);
            converterTarget(route->core,0); converterTarget(route->core,pid);
        }
        uint32_t dest; char ch; bool space;
        for (;;) {
            { std::lock_guard lock(route->mutex); if (!converterCharacter(route->core,&dest,&ch,&space)) break; }
            if (!target || dest!=pid || GetForegroundWindow()!=target) continue;
            INPUT input[4]{}; unsigned count=0;
            auto add=[&](wchar_t c) {
                INPUT down{}; down.type=INPUT_KEYBOARD; down.ki.wScan=c; down.ki.dwFlags=KEYEVENTF_UNICODE;
                input[count++]=down; down.ki.dwFlags|=KEYEVENTF_KEYUP; input[count++]=down;
            };
            if (space) add(L' '); add(static_cast<unsigned char>(ch));
            if (GetForegroundWindow()==target && SendInput(count,input,sizeof(INPUT))!=count) {
                disarm(); dirty=true; return;
            }
        }
    }
    void drain() {
        if (!route) return;
        HRESULT hr=route->result;
        if (FAILED(hr)) {
            stop(); retry=GetTickCount64()+4000;
            if (hr==E_ACCESSDENIED) reason=L"Allow desktop apps to access the microphone in Windows privacy settings.";
            else if (hr==AUDCLNT_E_UNSUPPORTED_FORMAT) reason=L"Use stereo headphones for converter output and a compatible headset microphone.";
            else { std::wostringstream message; message<<L"Windows audio unavailable (0x"<<std::hex<<static_cast<unsigned long>(hr)<<L"). Check the selected devices."; reason=message.str(); }
            return;
        }
        if (hr!=S_OK) return;
        ConverterState next; ConverterProfile completed{}; std::vector<ConverterEdge> edges;
        {
            std::lock_guard lock(route->mutex);
            next=converterState(route->core);
            if (next.calibration==InputCalibrated && state.calibration!=InputCalibrated) completed=converterProfile(route->core);
            ConverterEdge e; while (converterEdge(route->core,&e)) edges.push_back(e);
        }
        if (next.epoch!=epoch) { disarm(); epoch=next.epoch; resetEvent(); }
        if (next.calibration==InputCalibrated && state.calibration!=InputCalibrated) keepProfile(completed);
        bool available=source==L"vband" || next.ready;
        wstring detail=available ? (source==L"vband" ? L"VBand USB ready." : L"Converter ready.") :
            (next.calibration>=InputReleased && next.calibration<=InputBoth ? L"Measuring the converter in Settings." : L"Release both paddles while the converter measures its idle level.");
        if (state.mask!=next.mask || state.calibration!=next.calibration || state.sampling!=next.sampling || ready!=available || reason!=detail) dirty=true;
        state=next; ready=available; reason=detail;
        if (typing && !canArm()) disarm();
        if (dirty) status();
        for (const auto& e:edges) if (e.epoch==epoch) {
            Json j; str(j,L"type",L"element"); num(j,L"epoch",epoch); num(j,L"seq",double(++sequence));
            num(j,L"kind",e.kind); num(j,L"frame",double(e.frame)); num(j,L"rate",e.rate); emit(j);
        }
        focus();
    }
public:
    Host(const fs::path& dir,bool isolated,DWORD parent):file(dir/L"windows-audio.json"),parent(parent),isolated(isolated) {
        fs::create_directories(dir);
        std::ifstream stream(file,std::ios::binary);
        if (stream) {
            std::ostringstream data; data<<stream.rdbuf();
            Json recovered;
            if (Json::TryParse(winrt::to_hstring(data.str()),recovered)) prefs=recovered;
            else saveIssue=L"Audio preferences could not be read. Select the converter devices again.";
        }
        pilot=prefs.GetNamedString(L"pilot",L""); mic=prefs.GetNamedString(L"mic",L"");
        output=prefs.GetNamedString(L"output",L"auto"); settings.reverse=prefs.GetNamedBoolean(L"reverse",false);
        settings.spaces=prefs.GetNamedBoolean(L"spaces",false);
    }
    void tick() {
        if (GetTickCount64()>=nextScan) scan();
        reconcile(); drain(); if (dirty) status();
    }
    Json command(const Json& msg) {
        auto op=msg.GetNamedString(L"op"); Json result;
        if (op==L"input") {
            wstring chosen=msg.GetNamedString(L"value").c_str();
            if (chosen!=L"off" && chosen!=L"vband" && chosen!=L"paddle") return error(L"Unknown paddle input.");
            if (source!=chosen) { stop(); source=chosen; retry=0; }
        } else if (op==L"output" || op==L"pilot" || op==L"mic") {
            wstring id=msg.GetNamedString(L"value").c_str(); if (id==L"none") id.clear();
            bool special=op==L"output" && (id==L"auto" || id==L"silent");
            if (!special && !id.empty() && idName(op==L"mic" ? devices.inputs : devices.outputs,id).empty()) return error(L"Audio device is disconnected.");
            if (op==L"output" && id.empty()) return error(L"Choose a sidetone output.");
            (op==L"output" ? output : op==L"mic" ? mic : pilot)=id;
            str(prefs,op.c_str(),id); save(); retry=0; dirty=true;
        } else if (op==L"status") dirty=true;
        else if (op==L"capture-position") { drain(); num(result,L"sequence",double(sequence)); }
        else if (op==L"interrupt" || op==L"disarm") { interrupt(); }
        else if (op==L"arm") {
            if (!canArm()) return error(L"Connect and calibrate the audio converter before enabling external typing.");
            interrupt(); typing=true; dirty=true;
        } else if (op==L"vband" || op==L"vband-release") {
            if (source==L"vband" && route && ready) {
                if (op==L"vband-release") interrupt();
                else {
                    auto v=msg.GetNamedObject(L"value");
                    if (v.GetNamedNumber(L"epoch")!=epoch) return error(L"VBand input was interrupted.");
                    std::lock_guard lock(route->mutex); converterContacts(route->core,unsigned(v.GetNamedNumber(L"mask"))&3);
                }
            } else if (op==L"vband") return error(L"VBand output is unavailable.");
        } else if (op==L"mute") {
            muted=msg.GetNamedBoolean(L"value") && !typing;
            if (route) { std::lock_guard lock(route->mutex); converterMute(route->core,muted); }
        } else if (op==L"calibrate" || op==L"sample" || op==L"cancelCalibration" || op==L"automatic") {
            if (!route || source!=L"paddle" || route->result!=S_OK) return error(L"Select connected converter headphones and a headset microphone first.");
            if (op!=L"sample") interrupt();
            {
                std::lock_guard lock(route->mutex);
                if (op==L"calibrate") converterCalibrate(route->core);
                else if (op==L"sample") converterSample(route->core,msg.GetNamedBoolean(L"value"));
                else converterEndCalibration(route->core,op==L"automatic");
            }
            if (op==L"automatic") { auto all=profiles(); if (all.HasKey(profileKey())) all.Remove(profileKey()); save(); }
            dirty=true;
        } else {
            auto next=settings;
            if (op==L"reverse") {
                next.reverse=msg.GetNamedBoolean(L"value"); flag(prefs,L"reverse",next.reverse); save();
            } else if (op==L"word-spaces") {
                next.spaces=msg.GetNamedBoolean(L"value"); flag(prefs,L"spaces",next.spaces); save();
            } else if (op==L"volume") next.volume=unsigned(msg.GetNamedNumber(L"value"));
            else if (op==L"sound" || op==L"keyer" || op==L"envelope") {
                auto v=msg.GetNamedObject(L"value");
                if (op!=L"envelope") { next.wpm=unsigned(v.GetNamedNumber(L"wpm")); next.spacing=unsigned(v.GetNamedNumber(L"farnsworth")); next.modeB=v.GetNamedString(L"keyer")==L"b"; }
                if (op!=L"keyer") {
                    next.pitch=unsigned(v.GetNamedNumber(L"pitch")); next.rise=unsigned(v.GetNamedNumber(L"rise"));
                    next.fall=unsigned(v.GetNamedNumber(L"fall")); next.curve=unsigned(v.GetNamedNumber(L"curve"));
                    if (op==L"sound") next.volume=unsigned(v.GetNamedNumber(L"volume"));
                    else next.spaces=v.GetNamedBoolean(L"wordSpaces");
                }
            } else return error(L"Unknown paddle command.");
            if (next.reverse!=settings.reverse || next.wpm!=settings.wpm || next.spacing!=settings.spacing || next.modeB!=settings.modeB) interrupt();
            settings=next;
            if (route) { std::lock_guard lock(route->mutex); converterConfigure(route->core,&settings); }
            dirty=true;
            if (op==L"sound") { drain(); num(result,L"sequence",double(sequence)); }
        }
        tick(); return result;
    }
};

int wmain(int argc,wchar_t **argv) {
    if (argc!=4) return 2;
    try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        Host host(argv[1],wstring(argv[2])==L"isolated",wcstoul(argv[3],nullptr,10));
        winrt::handle wake(CreateEventW(nullptr,FALSE,FALSE,nullptr)); winrt::check_bool(bool(wake));
        std::mutex mutex; std::deque<std::string> commands; bool ended=false;
        std::thread reader([&]{
            std::string line;
            while (std::getline(std::cin,line)) {
                if (line.size()>65536) break;
                { std::lock_guard lock(mutex); commands.push_back(std::move(line)); }
                SetEvent(wake.get());
            }
            { std::lock_guard lock(mutex); ended=true; } SetEvent(wake.get());
        });
        for (;;) {
            host.tick();
            std::deque<std::string> pending; bool eof;
            { std::lock_guard lock(mutex); commands.swap(pending); eof=ended; }
            for (const auto& line:pending) {
                Json m; if (!Json::TryParse(winrt::to_hstring(line),m)) continue;
                Json reply; str(reply,L"type",L"reply"); num(reply,L"id",m.GetNamedNumber(L"id",0));
                try { reply.Insert(L"value",host.command(m)); }
                catch (const winrt::hresult_error&) { reply.Insert(L"value",error(L"Invalid Windows paddle setting.")); }
                emit(reply);
            }
            if (eof) break;
            WaitForSingleObject(wake.get(),8);
        }
        reader.join();
    } catch (...) { return 1; }
    return 0;
}
