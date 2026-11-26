#pragma once
#include "Converter.h"
#include <windows.h>
#include <mmdeviceapi.h>
#include <winrt/base.h>
#include <atomic>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct Endpoint { std::wstring id, name; };
struct Devices {
    std::vector<Endpoint> outputs, inputs;
    std::wstring defaultOutput;
};
Devices listDevices(IMMDeviceEnumerator *enumerator);

// A route owns one fixed set of endpoints. Its worker owns all WASAPI objects.
// The control thread only takes the DSP lock for bounded in-memory operations.
class AudioRoute {
    winrt::handle stopEvent;
    std::thread worker;
    void run(const std::wstring& pilot, const std::wstring& mic, const std::wstring& speaker);
public:
    std::mutex mutex;
    Converter *core;
    std::atomic<HRESULT> result{S_FALSE};
    AudioRoute(std::wstring pilot, std::wstring mic, std::wstring speaker, unsigned epoch,
               const ConverterSettings& settings, const ConverterProfile& profile);
    ~AudioRoute();
    AudioRoute(const AudioRoute&) = delete;
};
