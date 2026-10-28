#pragma once
#include <oboe/Oboe.h>
#include <memory>
#include <mutex>
#include <vector>
#include <atomic>
#include <cstdint>
#include <android/asset_manager.h>
#include "Track.h"
#include "HrtfBank.h"

class AudioEngine : public oboe::AudioStreamCallback {
public:
    AudioEngine();
    ~AudioEngine();

    // === MediaPlayer-style API (global) ===
    bool start();
    void pause();
    void resume();
    void stop();

    // === Global progress helpers ===
    int64_t getCurrentPositionAllMs() const; // reference position (first stem)
    int64_t getDurationMs() const;        // total duration (first stem)
    void    seekToAll(int64_t ms);           // synchronized seek on every stem

    // Real output latency in ms (measured via Oboe getTimestamp). 0 when unavailable.
    int64_t getOutputLatencyMs() const;

    // === Per-track ===
    int   addTrack(const char* path, bool loop);
    void  setTempo(int trackId, float tempo);
    void  setPitch(int trackId, float semi);
    void  setVolume(int trackId, float left, float right);
    // === Per-track 3D mode (ITD/ILD/distance) ===
    void  setTrack3DEnabled(int trackId, bool enabled);
    void  setTrack3DPosition(int trackId, float azimuthRad, float distance, float elevationDeg);
    void  setTrack3DOmnipresent(int trackId, bool omni);
    void  setTrack3DMuted(int trackId, bool muted);
    void  setTrackSoloMuted(int trackId, bool muted);
    // === Per-track FX (not persisted) ===
    void  setTrackFilter(int trackId, float amount);                    // -1..1, 0 = off
    void  setTrackEcho(int trackId, float amount, float delaySourceMs); // 0..1
    void  setTrackReverbSend(int trackId, float send, int room);        // 0..1, room 0..2
    // Loudness envelope of a track (dBFS every Track::ENVELOPE_HOP_MS).
    std::vector<float> getTrackEnvelope(int trackId) const;
    /** Loads the HRIRs from `assets/<assetPath>` and propagates them to all tracks
     *  (new and existing). Call once at startup. Returns true when loaded. */
    bool  initHrtfFromAssets(AAssetManager* mgr, const char* assetPath);
    // Global attenuation applied to the final mix (1.0 = normal, ~0.3 for a navigation "duck")
    void  setDuckFactor(float factor);
    void  seekToMs(int trackId, int64_t ms);
    int64_t getCurrentPositionMs(int trackId) const;

    // === Downbeat click (sample-accurate, same pipeline as the music) ===
    // Loads the click WAV. Returns true on success. Path must be a file (e.g. extracted from res/raw to cache).
    bool setClickWav(const char* path);
    // Schedules a click fire when the song crosses sourceMs (source time, not wall time).
    void scheduleClickAt(int64_t sourceMs);
    // Clears the queue of pending fires.
    void clearClickSchedule();
    // Global click enable/disable (does not clear the queue).
    void setClickEnabled(bool enabled);
    // Which track the engine ducks when the click fires (typically the active
    // metronome). -1 disables ducking. Java must update it when the metronome changes.
    void setClickDuckTrack(int trackId);

    // === Oboe ===
    oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream,
                                          void* audioData,
                                          int32_t numFrames) override;
    void onErrorBeforeClose(oboe::AudioStream* stream, oboe::Result error) override;
    void onErrorAfterClose (oboe::AudioStream* stream, oboe::Result error) override;

private:
    bool createStream();
    void closeStream();
    void recomputeAnyST(); // checks whether any track uses non-neutral pitch/tempo

    std::unique_ptr<oboe::AudioStream> mStream;
    std::vector<std::unique_ptr<Track>> mTracks;
    // Serialises push_back into mTracks when multiple Java threads call
    // addTrack in parallel to decode stems concurrently. Only used during
    // song load — never touched from the audio thread.
    std::mutex mAddTrackMutex;
    HrtfBank mHrtf;  // shared by all tracks
    // SoundTouch ALWAYS on (init true). All tracks are forced through the same
    // path so latency and mSrcPos consumption stay uniform; disabling it when
    // pitch=0/tempo=1 leaves drums (passthrough) and pitched (WSOLA) tracks
    // with mismatched mSrcPos → stems desync on exit.
    std::atomic<bool> mAnyST{true};

    int32_t mDeviceSampleRate = 48000;
    int32_t mChannels         = 2;
    oboe::AudioFormat mOutFmt = oboe::AudioFormat::Float;

    std::atomic<bool> mPaused{false};
    std::atomic<bool> mDestroying{false};
    std::atomic<bool> mStarted{false}; // blocks addTrack after start
    // Real user intent (play vs pause). The recovery honors it to avoid
    // resurrecting audio after a BT disconnect (Oboe triggers a stream reopen).
    std::atomic<bool> mUserWantsPlay{false};
    std::atomic<float> mDuckFactor{1.f}; // global mix attenuation (1=normal)
    // Shared reverb buses (one per room size) fed by the per-track sends
    // (audio thread only).
    fx::Reverb mReverbs[fx::Reverb::ROOMS] = {fx::Reverb(0), fx::Reverb(1), fx::Reverb(2)};
    int32_t mWarmupFrames = 0; // initial silence to prime the pipeline

    // Downbeat click. Separate track (not in mTracks because its lifetime is
    // independent from the song and can be replaced on-the-fly when the sound changes).
    // The pointer and the trigger queue are both guarded by mClickMutex.
    std::mutex mClickMutex;
    std::unique_ptr<Track> mClickTrack;
    // Trigger with a flag: `ducked` becomes true when the music reaches sourceMs,
    // fire happens when the music reaches sourceMs+LEAD (and the trigger is removed).
    struct ClickTrigger { int64_t sourceMs; bool ducked = false; };
    std::vector<ClickTrigger> mClickTriggers; // sorted by sourceMs ascending
    std::atomic<bool>      mClickEnabled{false};
    // Metronome ducking when the click fires
    std::atomic<int>       mClickDuckTrackId{-1};
    int                    mClickDuckRemainingFrames = 0; // accessed only from the audio thread
    static constexpr int   CLICK_DUCK_MS = 160;            // gap duration in ms
};
