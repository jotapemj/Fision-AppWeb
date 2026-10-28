#include "AudioEngine.h"
#include <android/log.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <thread>

#define TAG "AudioEngine"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)

AudioEngine::AudioEngine(){ mTracks.reserve(8); createStream(); }
AudioEngine::~AudioEngine(){ mDestroying.store(true); closeStream(); }

bool AudioEngine::createStream(){
    oboe::AudioStreamBuilder b;
    b.setDirection(oboe::Direction::Output);
    // PerformanceMode::None: the system grants a more generous buffer and lower
    // priority → underruns become nearly nonexistent. Adds ~100-150ms of total
    // latency, unnoticeable during music playback (would matter for live monitoring).
    b.setPerformanceMode(oboe::PerformanceMode::None);
    // Shared: uses the system mixer path. Still the correct choice here.
    b.setSharingMode(oboe::SharingMode::Shared);
    b.setChannelCount(2);
    b.setFormat(oboe::AudioFormat::Float);
    b.setSampleRate(oboe::kUnspecified); // native
    // Ask the builder for large capacity so setBufferSizeInFrames does not get capped
    b.setBufferCapacityInFrames(8192);
    b.setCallback(this);

    oboe::AudioStream* raw = nullptr;
    auto res = b.openStream(&raw);
    if(res != oboe::Result::OK){ LOGE("openStream: %s", oboe::convertToText(res)); return false; }
    mStream.reset(raw);

    mDeviceSampleRate = mStream->getSampleRate();
    mChannels         = mStream->getChannelCount();
    mOutFmt           = mStream->getFormat();

    for (auto& r : mReverbs) r.setSampleRate(mDeviceSampleRate);
    // When tracks already exist (reopen from device change — BT/jack), recalibrate them to the new SR
    for (auto& t : mTracks) t->setDeviceSampleRate(mDeviceSampleRate);
    // The click track lives outside mTracks; it also needs recalibration
    {
        std::lock_guard<std::mutex> lock(mClickMutex);
        if (mClickTrack) mClickTrack->setDeviceSampleRate(mDeviceSampleRate);
    }

    const int fpb = mStream->getFramesPerBurst();
    // Large buffer (4 bursts in PerformanceMode::None, where fpb is already large).
    // Enough headroom to survive load spikes (UI thread, GC, decode).
    (void)mStream->setBufferSizeInFrames(fpb * 4);
    LOGI("Stream: SR=%d ch=%d fpb=%d bufSize=%d cap=%d fmt=%s",
         mDeviceSampleRate, mChannels, fpb,
         mStream->getBufferSizeInFrames(),
         mStream->getBufferCapacityInFrames(),
         oboe::convertToText(mOutFmt));
    return true;
}

void AudioEngine::closeStream(){
    if(mStream){
        // 1) Force the callback to silence so the system buffer fills with zeros
        mPaused.store(true);
        // 2) Give the HW time to consume the "silent" buffer
        std::this_thread::sleep_for(std::chrono::milliseconds(60));
        // 3) Stop (synchronous) and close
        mStream->stop();
        mStream->close();
        mStream.reset();
    }
    mStarted.store(false, std::memory_order_release);
}

int AudioEngine::addTrack(const char* path, bool loop){
    // Do not allow adding tracks while the stream is running (audio thread reads mTracks lock-free)
    if (mStarted.load(std::memory_order_acquire)) {
        LOGE("addTrack rejected: engine already started");
        return -1;
    }
    // Decode outside the mutex — this is the expensive part (WAV/FLAC decode,
    // resampler warm-up) and we want parallel callers to overlap here.
    auto t = std::make_unique<Track>(path, loop, mDeviceSampleRate, /*outCh=*/2);
    if (mHrtf.isLoaded()) t->setHrtfBank(&mHrtf);
    // Only serialise the push_back so parallel Java callers cannot race on the
    // vector's storage. Once the stream is started the audio thread reads
    // mTracks lock-free — addTrack is rejected at that point (see above).
    std::lock_guard<std::mutex> lock(mAddTrackMutex);
    int id = (int)mTracks.size();
    mTracks.push_back(std::move(t));
    return id;
}

bool AudioEngine::initHrtfFromAssets(AAssetManager* mgr, const char* assetPath){
    bool ok = mHrtf.loadFromAssets(mgr, assetPath);
    if (ok) {
        for (auto& t : mTracks) t->setHrtfBank(&mHrtf);
    }
    return ok;
}

void AudioEngine::setTempo (int id, float v){
    if(id>=0 && id<(int)mTracks.size()) { mTracks[id]->setTempo(v); recomputeAnyST(); }
}
void AudioEngine::setPitch (int id, float v){
    if(id>=0 && id<(int)mTracks.size()) { mTracks[id]->setPitch(v); recomputeAnyST(); }
}

void AudioEngine::recomputeAnyST(){
    // STICKY: once any track activates SoundTouch on this song, all tracks stay
    // in the ST path for the rest of the song.
    // Reason: while in ST, each track consumes mSrcPos at a different rate
    // (drums passthrough vs WSOLA pitched). Falling back to direct passthrough
    // leaves the mSrcPos values misaligned → stems desynchronize on exit.
    // Cost: WSOLA in passthrough introduces subtle artifacts. Acceptable.
    bool any = false;
    for (auto& t : mTracks) {
        if (t->hasNonNeutralPitchOrTempo()) { any = true; break; }
    }
    if (any) mAnyST.store(true, std::memory_order_release);
    // When any=false mAnyST stays as it was (sticky).
}
void AudioEngine::setVolume(int id, float L, float R){ if(id>=0 && id<(int)mTracks.size()) mTracks[id]->setVolumeLR(L,R); }

void AudioEngine::setTrack3DEnabled(int id, bool e){
    if(id>=0 && id<(int)mTracks.size()) mTracks[id]->set3DEnabled(e);
}
void AudioEngine::setTrack3DPosition(int id, float azimuthRad, float distance, float elevationDeg){
    if(id>=0 && id<(int)mTracks.size()) mTracks[id]->set3DPosition(azimuthRad, distance, elevationDeg);
}
void AudioEngine::setTrack3DOmnipresent(int id, bool o){
    if(id>=0 && id<(int)mTracks.size()) mTracks[id]->set3DOmnipresent(o);
}
std::vector<float> AudioEngine::getTrackEnvelope(int id) const {
    if (id < 0 || id >= (int) mTracks.size()) return {};
    return mTracks[id]->getEnvelopeDb();
}

void AudioEngine::setTrackFilter(int id, float a){
    if(id>=0 && id<(int)mTracks.size()) mTracks[id]->setFxFilter(a);
}
void AudioEngine::setTrackEcho(int id, float a, float delaySourceMs){
    if(id>=0 && id<(int)mTracks.size()) mTracks[id]->setFxEcho(a, delaySourceMs);
}
void AudioEngine::setTrackReverbSend(int id, float s, int room){
    if(id>=0 && id<(int)mTracks.size()) {
        mTracks[id]->setReverbRoom(room);
        mTracks[id]->setReverbSend(std::min(1.f, s));
    }
}
void AudioEngine::setTrack3DMuted(int id, bool m){
    if(id>=0 && id<(int)mTracks.size()) mTracks[id]->set3DMuted(m);
}
void AudioEngine::setTrackSoloMuted(int id, bool m){
    if(id>=0 && id<(int)mTracks.size()) mTracks[id]->setSoloMuted(m);
}

int64_t AudioEngine::getOutputLatencyMs() const {
    if (!mStream) return 0;
    // Oboe getTimestamp: returns the frame currently being played + system time.
    // Latency = frames written - frames playing, divided by SR.
    int64_t framesWritten = mStream->getFramesWritten();
    auto result = mStream->getTimestamp(CLOCK_MONOTONIC);
    if (!result) return 0; // not supported on this device → Java fallback
    auto ts = result.value();
    int64_t latencyFrames = framesWritten - ts.position;
    if (latencyFrames < 0) return 0;
    if (mDeviceSampleRate <= 0) return 0;
    return (latencyFrames * 1000) / mDeviceSampleRate;
}
void AudioEngine::setDuckFactor(float f){ if(f<0.f) f=0.f; if(f>1.f) f=1.f; mDuckFactor.store(f, std::memory_order_release); }

// === Downbeat click ===
bool AudioEngine::setClickWav(const char* path){
    if(!path) { LOGE("setClickWav: path null"); return false; }
    auto t = std::make_unique<Track>(path, /*loop=*/false, mDeviceSampleRate, /*outCh=*/2);
    int64_t dur = t->getDurationMs();
    if (dur <= 0) {
        LOGE("setClickWav: WAV not loaded (dur=0) - unsupported format? path=%s", path);
        return false;
    }
    // Start "ended" (silent) until the first trigger. Seek to the end.
    t->seekToMs(dur);
    {
        // Swap only: the audio callback takes this mutex, so the previous
        // track (PCM + SoundTouch) is freed after the lock, in t's destructor.
        std::lock_guard<std::mutex> lock(mClickMutex);
        mClickTrack.swap(t);
        mClickTriggers.clear();
    }
    LOGI("setClickWav: OK %s (dur=%lld ms)", path, (long long)dur);
    return true;
}

void AudioEngine::scheduleClickAt(int64_t sourceMs){
    std::lock_guard<std::mutex> lock(mClickMutex);
    auto cmp = [](const ClickTrigger& t, int64_t v){ return t.sourceMs < v; };
    auto it = std::lower_bound(mClickTriggers.begin(), mClickTriggers.end(), sourceMs, cmp);
    if (it != mClickTriggers.end() && it->sourceMs == sourceMs) return; // already exists
    mClickTriggers.insert(it, ClickTrigger{sourceMs, false});
}

void AudioEngine::clearClickSchedule(){
    std::lock_guard<std::mutex> lock(mClickMutex);
    mClickTriggers.clear();
}

void AudioEngine::setClickEnabled(bool e){
    mClickEnabled.store(e, std::memory_order_release);
}

void AudioEngine::setClickDuckTrack(int trackId){
    int prev = mClickDuckTrackId.exchange(trackId, std::memory_order_acq_rel);
    // Restore the previous track when it was ducked and is no longer the active one
    if (prev != trackId && prev >= 0 && prev < (int)mTracks.size()) {
        mTracks[prev]->setEngineDuckMul(1.f);
    }
}

void AudioEngine::seekToMs(int id, int64_t ms){ if(id>=0 && id<(int)mTracks.size()) mTracks[id]->seekToMs(ms); }
int64_t AudioEngine::getCurrentPositionMs(int id) const { return (id>=0 && id<(int)mTracks.size()) ? mTracks[id]->getCurrentPositionMs() : 0; }

// === Global methods ===

int64_t AudioEngine::getDurationMs() const {
    if (mTracks.empty()) return 0;
    return mTracks[0]->getDurationMs(); // reference: first stem
}

void AudioEngine::seekToAll(int64_t ms){
    for (auto& t : mTracks) t->seekToMs(ms);
}

int64_t AudioEngine::getCurrentPositionAllMs() const {
    if (mTracks.empty()) return 0;
    return mTracks[0]->getCurrentPositionMs(); // reference: first stem
}

bool AudioEngine::start(){
    if(!mStream) return false;
    const int fpb = mStream->getFramesPerBurst();
    mWarmupFrames = fpb * 2;
    mPaused.store(false);
    mUserWantsPlay.store(true, std::memory_order_release);
    mStarted.store(true, std::memory_order_release);
    return mStream->requestStart() == oboe::Result::OK;
}

void AudioEngine::pause(){ mPaused.store(true); mUserWantsPlay.store(false, std::memory_order_release); }
void AudioEngine::resume(){ mPaused.store(false); mUserWantsPlay.store(true, std::memory_order_release); }
void AudioEngine::stop(){ if(mStream) mStream->requestStop(); }

oboe::DataCallbackResult AudioEngine::onAudioReady(oboe::AudioStream* stream, void* audioData, int32_t numFrames){
    const int ch = mChannels;
    // XRun (underrun) log every ~5s for glitch diagnostics
    static thread_local int xrunLogCounter = 0;
    if (++xrunLogCounter > 500) {
        xrunLogCounter = 0;
        auto xr = stream->getXRunCount();
        if (xr) LOGI("XRunCount=%d", xr.value());
    }
    static thread_local std::vector<float> mix; mix.assign(numFrames*ch, 0.f);

    if(mPaused.load() || mWarmupFrames>0){
        if(mWarmupFrames>0){ mWarmupFrames -= std::min(mWarmupFrames, numFrames); }
        if(mOutFmt == oboe::AudioFormat::I16) std::memset(audioData, 0, numFrames*ch*sizeof(int16_t));
        else std::fill_n(static_cast<float*>(audioData), numFrames*ch, 0.f);
        return oboe::DataCallbackResult::Continue;
    }

    // ask each track
    // forceST: when any track has active pitch/tempo, all tracks go through ST
    // so latency stays uniform and stems stay synchronized
    const bool forceST = mAnyST.load(std::memory_order_acquire);
    static thread_local std::vector<float> tmp; tmp.resize(numFrames*ch);

    // Downbeat click: see the comment above about why it does NOT go through ST
    // (warmup overshoot with short WAVs). Detection in TWO phases (duck and fire)
    // with a per-trigger flag to avoid duplicating the duck. The "<=endMs" condition
    // (catch-up): when a trigger is added a little late for any reason, it still
    // fires once the music has ALREADY passed the moment — the note is not lost.
    constexpr int64_t CLICK_LEAD_MS = 100;
    bool clickDuckTriggeredThisCallback = false;
    if (mClickEnabled.load(std::memory_order_acquire) && !mTracks.empty()) {
        int64_t startMs = mTracks[0]->getCurrentPositionMs();
        int64_t deltaMs = (int64_t)numFrames * 1000 / mDeviceSampleRate;
        int64_t endMs   = startMs + deltaMs;
        std::lock_guard<std::mutex> lock(mClickMutex);
        if (mClickTrack && !mClickTriggers.empty()) {
            // Drop very old triggers (more than 300ms past the fire window).
            // Wide margin: better to fire late than lose a downbeat.
            while (!mClickTriggers.empty()
                   && (mClickTriggers.front().sourceMs + CLICK_LEAD_MS + 300) < startMs) {
                mClickTriggers.erase(mClickTriggers.begin());
            }
            if (!mClickTriggers.empty()) {
                auto& front = mClickTriggers.front();
                // (1) Metronome duck: when the music has reached sourceMs.
                //     The `ducked` flag avoids re-arming on later callbacks.
                if (!front.ducked && front.sourceMs <= endMs) {
                    front.ducked = true;
                    clickDuckTriggeredThisCallback = true;
                }
                // (2) Click fire: when the music has reached sourceMs + LEAD.
                if ((front.sourceMs + CLICK_LEAD_MS) <= endMs) {
                    mClickTriggers.erase(mClickTriggers.begin());
                    mClickTrack->seekToMs(0);
                }
            }
        }
    }

    // Metronome ducking: starts when the music renders the beat (not when the
    // click fires). That way the metronome tick is audibly muted before the click
    // sounds; both share the remaining latency (Oboe) and are perceived as
    // synchronized: a gap with the click on top.
    int duckId = mClickDuckTrackId.load(std::memory_order_acquire);
    if (clickDuckTriggeredThisCallback && duckId >= 0 && duckId < (int)mTracks.size()) {
        mTracks[duckId]->setEngineDuckMul(0.f);
        mClickDuckRemainingFrames = (CLICK_DUCK_MS * mDeviceSampleRate) / 1000;
    }
    if (mClickDuckRemainingFrames > 0) {
        mClickDuckRemainingFrames -= numFrames;
        if (mClickDuckRemainingFrames <= 0) {
            mClickDuckRemainingFrames = 0;
            if (duckId >= 0 && duckId < (int)mTracks.size()) {
                mTracks[duckId]->setEngineDuckMul(1.f);
            }
        }
    }

    // Reverb buses: post-fader sends of every track, each room processed once.
    constexpr int ROOMS = fx::Reverb::ROOMS;
    static thread_local std::vector<float> rev[ROOMS];
    bool anySend[ROOMS] = {false, false, false};
    for (int r = 0; r < ROOMS; ++r) rev[r].assign(numFrames*ch, 0.f);
    for(auto& t : mTracks){
        std::fill(tmp.begin(), tmp.end(), 0.f);
        int got = t->render(tmp.data(), numFrames, forceST); // rendered frames
        for(int i=0;i<got*ch;++i) mix[i] += tmp[i];
        const float send = t->getReverbSend();
        if (send > 0.f) {
            const int r = t->getReverbRoom();
            anySend[r] = true;
            float* bus = rev[r].data();
            for(int i=0;i<got*ch;++i) bus[i] += tmp[i] * send;
        }
    }
    if (ch == 2) {
        for (int r = 0; r < ROOMS; ++r) {
            if (!anySend[r] && !mReverbs[r].isActive()) continue;
            mReverbs[r].process(rev[r].data(), numFrames);
            const float* bus = rev[r].data();
            for(int i=0;i<numFrames*ch;++i) mix[i] += bus[i];
        }
    }

    // Click track: render and mix. Does NOT go through SoundTouch (forceST=false). Reasons:
    //  - ST warmup consumes ~200ms of source; short click WAVs (50-150ms)
    //    outrun the warmup → WSOLA glitches and the sound is cut off.
    //  - Sample-accurate without WSOLA. Alignment with the music (which does go
    //    through ST) is compensated by delaying the trigger by CLICK_LEAD_MS above.
    if (mClickEnabled.load(std::memory_order_acquire)) {
        std::lock_guard<std::mutex> lock(mClickMutex);
        if (mClickTrack) {
            std::fill(tmp.begin(), tmp.end(), 0.f);
            int got = mClickTrack->render(tmp.data(), numFrames, /*forceST=*/false);
            for(int i=0;i<got*ch;++i) mix[i] += tmp[i];
        }
    }

    const int N = numFrames*ch;
    // Global attenuation (duck) for navigation prompts / assistants
    const float duck = mDuckFactor.load(std::memory_order_acquire);
    if (duck < 0.999f) {
        for (int i=0;i<N;++i) mix[i] *= duck;
    }

    // Soft-knee limiter: lineal hasta |x|=THR, comprime suave en [THR..1], hard limit a CEIL.
    // Replaces the global tanh (which distorts transients when several stems sum peaks).
    constexpr float THR  = 0.7f;   // below this, output is linear
    constexpr float CEIL = 0.95f;  // absolute ceiling
    constexpr float SPAN = 1.0f - THR;   // 0.3
    constexpr float DELTA = CEIL - THR;  // 0.25
    for(int i=0;i<N;++i){
        float x = mix[i];
        float a = std::fabs(x);
        if (a <= THR) continue;                 // linear zone: untouched
        if (a >= 1.0f) { mix[i] = std::copysign(CEIL, x); continue; }
        float over   = (a - THR) / SPAN;        // 0..1
        float curved = THR + DELTA * (1.0f - (1.0f - over) * (1.0f - over)); // ease-out
        mix[i] = std::copysign(curved, x);
    }

    if(mOutFmt == oboe::AudioFormat::I16){
        int16_t* out = static_cast<int16_t*>(audioData);
        for(int i=0;i<N;++i){ float x = std::max(-1.f, std::min(1.f, mix[i])); out[i] = (int16_t)lrintf(x*32767.f); }
    } else {
        float* out = static_cast<float*>(audioData);
        std::copy(mix.begin(), mix.end(), out);
    }
    return oboe::DataCallbackResult::Continue;
}

void AudioEngine::onErrorBeforeClose(oboe::AudioStream*, oboe::Result error){
    LOGE("onErrorBeforeClose: %s", oboe::convertToText(error));
}

void AudioEngine::onErrorAfterClose(oboe::AudioStream*, oboe::Result error){
    LOGE("onErrorAfterClose: %s", oboe::convertToText(error));
    // Recovery on a separate thread: the Oboe error thread must not be blocked
    if (mDestroying.load()) return;
    std::thread([this]{
        if (mDestroying.load()) return;
        closeStream();
        if (mDestroying.load()) return;
        createStream();
        if (mDestroying.load()) return;
        // start() is not called to preserve the user's intent.
        // When pause() arrived during the close (BECOMING_NOISY on BT disconnect),
        // mUserWantsPlay is false → the stream stays open but silent.
        if (mStream) {
            const int fpb = mStream->getFramesPerBurst();
            mWarmupFrames = fpb * 2;
            mStream->requestStart();
            mStarted.store(true, std::memory_order_release);
            // Sync mPaused with the user's intent after reopen
            mPaused.store(!mUserWantsPlay.load(std::memory_order_acquire),
                          std::memory_order_release);
        }
    }).detach();
}