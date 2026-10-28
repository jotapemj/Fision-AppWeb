// Shim minimo de Oboe para compilar AudioEngine.cpp sin tocarlo.
// No abre audio: el AudioWorklet llama a onAudioReady() a mano.
#pragma once
#include <cstdint>
#include <ctime>

namespace oboe {

constexpr int32_t kUnspecified = 0;

enum class Direction { Output, Input };
enum class PerformanceMode { None, PowerSaving, LowLatency };
enum class SharingMode { Exclusive, Shared };
enum class AudioFormat { Unspecified, I16, Float };
enum class Result { OK, ErrorBase, ErrorUnavailable };
enum class DataCallbackResult { Continue, Stop };

template <typename T> inline const char* convertToText(T) { return "shim"; }

struct FrameTimestamp { int64_t position; int64_t timestamp; };

template <typename T>
class ResultWithValue {
public:
    ResultWithValue(Result e) : mOk(false), mValue{} { (void)e; }
    ResultWithValue(T v) : mOk(true), mValue(v) {}
    explicit operator bool() const { return mOk; }
    T value() const { return mValue; }
private:
    bool mOk;
    T mValue;
};

// Sample rate del AudioContext; lo fija fe_create() antes de crear el motor
extern int32_t gShimSampleRate;
constexpr int32_t kShimFramesPerBurst = 128; // quantum del AudioWorklet

class AudioStream {
public:
    int32_t getSampleRate() const { return gShimSampleRate; }
    int32_t getChannelCount() const { return 2; }
    AudioFormat getFormat() const { return AudioFormat::Float; }
    int32_t getFramesPerBurst() const { return kShimFramesPerBurst; }
    ResultWithValue<int32_t> setBufferSizeInFrames(int32_t n) { mBuf = n; return n; }
    int32_t getBufferSizeInFrames() const { return mBuf; }
    int32_t getBufferCapacityInFrames() const { return 8192; }
    Result requestStart() { return Result::OK; }
    Result requestStop() { return Result::OK; }
    Result stop() { return Result::OK; }
    Result close() { return Result::OK; }
    int64_t getFramesWritten() const { return 0; }
    // Latencia real la da el AudioContext en JS
    ResultWithValue<FrameTimestamp> getTimestamp(clockid_t) { return Result::ErrorUnavailable; }
    ResultWithValue<int32_t> getXRunCount() const { return 0; }
private:
    int32_t mBuf = 512;
};

class AudioStreamCallback {
public:
    virtual ~AudioStreamCallback() = default;
    virtual DataCallbackResult onAudioReady(AudioStream*, void*, int32_t) = 0;
    virtual void onErrorBeforeClose(AudioStream*, Result) {}
    virtual void onErrorAfterClose(AudioStream*, Result) {}
};

class AudioStreamBuilder {
public:
    AudioStreamBuilder& setDirection(Direction) { return *this; }
    AudioStreamBuilder& setPerformanceMode(PerformanceMode) { return *this; }
    AudioStreamBuilder& setSharingMode(SharingMode) { return *this; }
    AudioStreamBuilder& setChannelCount(int32_t) { return *this; }
    AudioStreamBuilder& setFormat(AudioFormat) { return *this; }
    AudioStreamBuilder& setSampleRate(int32_t) { return *this; }
    AudioStreamBuilder& setBufferCapacityInFrames(int32_t) { return *this; }
    AudioStreamBuilder& setCallback(AudioStreamCallback*) { return *this; }
    Result openStream(AudioStream** out) { *out = new AudioStream(); return Result::OK; }
};

} // namespace oboe
