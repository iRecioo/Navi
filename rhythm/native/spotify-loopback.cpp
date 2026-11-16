#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <tlhelp32.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <cstring>
#include <utility>
#include <vector>

// audioclientactivationparams.h is absent in some MinGW SDKs.
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
enum AUDIOCLIENT_ACTIVATION_TYPE { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK };
enum PROCESS_LOOPBACK_MODE { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE };
struct AUDIOCLIENT_ACTIVATION_PARAMS {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    struct { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE ProcessLoopbackMode; } ProcessLoopbackParams;
};
#endif

template<class T> struct ComPointer {
    T* value = nullptr;
    ~ComPointer() { if (value) value->Release(); }
    T* operator->() const { return value; }
};

struct Handle {
    HANDLE value;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    operator HANDLE() const { return value; }
};

class Activation final : public IActivateAudioInterfaceCompletionHandler {
    volatile LONG references = 1;
public:
    Handle ready{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
    HRESULT result = E_UNEXPECTED;
    ComPointer<IAudioClient> client;

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (id != __uuidof(IUnknown) && id != __uuidof(IActivateAudioInterfaceCompletionHandler)
            && id != __uuidof(IAgileObject)) return E_NOINTERFACE;
        *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        AddRef();
        return S_OK;
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references); }
    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG count = InterlockedDecrement(&references);
        if (!count) delete this;
        return count;
    }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        ComPointer<IUnknown> activated;
        HRESULT activationResult = E_UNEXPECTED;
        result = operation->GetActivateResult(&activationResult, &activated.value);
        if (SUCCEEDED(result)) result = activationResult;
        if (SUCCEEDED(result) && activated.value) result = activated->QueryInterface(IID_PPV_ARGS(&client.value));
        SetEvent(ready);
        return S_OK;
    }
};

static DWORD spotifyProcess() {
    Handle snapshot{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)};
    if (snapshot.value == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    std::vector<PROCESSENTRY32W> processes;
    if (Process32FirstW(snapshot, &entry)) {
        do {
            if (_wcsicmp(entry.szExeFile, L"Spotify.exe") == 0) processes.push_back(entry);
        } while (Process32NextW(snapshot, &entry));
    }
    DWORD root = 0;
    std::pair<const std::vector<PROCESSENTRY32W>&, DWORD&> search{processes, root};
    EnumWindows([](HWND window, LPARAM data) -> BOOL {
        auto& target = *reinterpret_cast<decltype(search)*>(data);
        DWORD pid = 0;
        GetWindowThreadProcessId(window, &pid);
        if (!IsWindowVisible(window) || !GetWindowTextLengthW(window)) return TRUE;
        for (const auto& process : target.first) {
            if (process.th32ProcessID == pid) { target.second = pid; return FALSE; }
        }
        return TRUE;
    }, reinterpret_cast<LPARAM>(&search));
    if (!root && !processes.empty()) root = processes[0].th32ProcessID;
    // Capture the root so Chromium's separate audio service is included.
    for (size_t level = 0; level < processes.size(); ++level) {
        DWORD parent = 0;
        for (const auto& process : processes) {
            if (process.th32ProcessID != root) continue;
            for (const auto& candidate : processes) {
                if (candidate.th32ProcessID == process.th32ParentProcessID) {
                    parent = candidate.th32ProcessID;
                    break;
                }
            }
            break;
        }
        if (!parent) break;
        root = parent;
    }
    return root;
}

static int report(const char* stage, HRESULT result) {
    std::fprintf(stderr, "%s 0x%08lx\n", stage, static_cast<unsigned long>(result));
    return 1;
}

static bool writeFull(HANDLE output, const void* buffer, DWORD size) {
    const auto* at = static_cast<const BYTE*>(buffer);
    while (size) {
        DWORD written = 0;
        if (!WriteFile(output, at, size, &written, nullptr) || !written) return false;
        at += written;
        size -= written;
    }
    return true;
}

static int capture(DWORD pid, HANDLE parent) {
    Handle spotify{OpenProcess(SYNCHRONIZE, FALSE, pid)};
    AUDIOCLIENT_ACTIVATION_PARAMS target{};
    target.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    target.ProcessLoopbackParams.TargetProcessId = pid;
    target.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    // The parameter blob stays alive until the asynchronous activation has completed.
    PROPVARIANT parameters{};
    parameters.vt = VT_BLOB;
    parameters.blob.cbSize = sizeof(target);
    parameters.blob.pBlobData = reinterpret_cast<BYTE*>(&target);
    ComPointer<IActivateAudioInterfaceCompletionHandler> activation;
    auto* completion = new Activation;
    activation.value = completion;
    if (!completion->ready.value) return report("event", HRESULT_FROM_WIN32(GetLastError()));
    ComPointer<IActivateAudioInterfaceAsyncOperation> operation;
    HRESULT result = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient), &parameters, completion, &operation.value);
    if (FAILED(result)) return report("activate", result);
    if (WaitForSingleObject(completion->ready, 5000) != WAIT_OBJECT_0) {
        // End the process before reclaiming a parameter blob still in use by COM.
        std::fprintf(stderr, "activate-timeout\n");
        ExitProcess(1);
    }
    if (FAILED(completion->result) || !completion->client.value) return report("activate-result", completion->result);

    constexpr DWORD rate = 44100;
    constexpr WORD bytesPerFrame = 4;
    WAVEFORMATEX format{WAVE_FORMAT_PCM, 2, rate, rate * bytesPerFrame, bytesPerFrame, 16, 0};
    auto& client = completion->client;
    result = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        0, 0, &format, nullptr);
    if (FAILED(result)) return report("initialize", result);
    ComPointer<IAudioCaptureClient> input;
    result = client->GetService(IID_PPV_ARGS(&input.value));
    if (FAILED(result)) return report("capture-service", result);
    Handle samples{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
    if (!samples.value) return report("samples", HRESULT_FROM_WIN32(GetLastError()));
    result = client->SetEventHandle(samples);
    if (FAILED(result)) return report("sample-event", result);
    result = client->Start();
    if (FAILED(result)) return report("start", result);

    // Each packet carries the sample clock in Unix milliseconds, then interleaved stereo PCM16.
    struct Packet { double time; UINT32 frames; UINT32 padding; };
    static_assert(sizeof(Packet) == 16, "Unexpected packet layout");
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    LARGE_INTEGER frequency{};
    QueryPerformanceFrequency(&frequency);
    std::vector<BYTE> audio;
    std::fprintf(stderr, "ready\n");
    while (true) {
        if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0) break;
        if (spotify.value && WaitForSingleObject(spotify, 0) == WAIT_OBJECT_0) break;
        if (WaitForSingleObject(samples, 250) != WAIT_OBJECT_0) continue;
        UINT32 pending = 0;
        result = input->GetNextPacketSize(&pending);
        while (SUCCEEDED(result) && pending) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            UINT64 stamp = 0;
            result = input->GetBuffer(&data, &frames, &flags, nullptr, &stamp);
            if (FAILED(result) || !frames) break;
            LARGE_INTEGER counter{};
            FILETIME utc{};
            QueryPerformanceCounter(&counter);
            GetSystemTimePreciseAsFileTime(&utc);
            ULARGE_INTEGER ticks{};
            ticks.HighPart = utc.dwHighDateTime;
            ticks.LowPart = utc.dwLowDateTime;
            const double now = (ticks.QuadPart - 116444736000000000ULL) / 10000.0;
            const double lag = counter.QuadPart * 1000.0 / frequency.QuadPart - stamp / 10000.0;
            const double time = !(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) && lag > -200 && lag < 2000
                ? now - lag : now - frames * 1000.0 / rate;
            const DWORD size = frames * bytesPerFrame;
            audio.resize(size);
            if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data) std::memset(audio.data(), 0, size);
            else std::memcpy(audio.data(), data, size);
            result = input->ReleaseBuffer(frames);
            if (FAILED(result)) break;
            const Packet header{time, frames, 0};
            if (!writeFull(output, &header, sizeof(header)) || !writeFull(output, audio.data(), size)) {
                client->Stop();
                return 0;
            }
            result = input->GetNextPacketSize(&pending);
        }
        if (FAILED(result)) {
            client->Stop();
            return report("capture", result);
        }
    }
    client->Stop();
    return 0;
}

int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wcscmp(argv[1], L"--version") == 0) {
        std::puts("Navi Spotify loopback 1");
        return 0;
    }
    if (argc != 2) return report("parent-pid", E_INVALIDARG);
    const DWORD process = std::wcstoul(argv[1], nullptr, 10);
    Handle parent{OpenProcess(SYNCHRONIZE, FALSE, process)};
    if (!parent.value) return report("parent-pid", HRESULT_FROM_WIN32(GetLastError()));
    const DWORD spotify = spotifyProcess();
    if (!spotify) return report("spotify-missing", HRESULT_FROM_WIN32(ERROR_NOT_FOUND));
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized)) return report("com", initialized);
    const int result = capture(spotify, parent);
    CoUninitialize();
    return result;
}
