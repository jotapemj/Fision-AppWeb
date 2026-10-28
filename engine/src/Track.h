#pragma once
#include <vector>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <climits>
#include <SoundTouch.h>
#include "HrtfBank.h"
#include "StemFx.h"

class Track {
public:
    Track(const char* path, bool loop, int deviceSR, int outCh);
    ~Track();

    // control
    void setTempo(float t);          // 0.5..2.0
    void setPitch(float semi);       // -24..+24
    void setVolumeLR(float L, float R);
    // === 3D mode (ITD + ILD + distance) ===
    // When active, mVolL/R + the user pan are ignored; the spatial position
    // (azimuth + distance) of the stem around the head drives volume and the
    // interaural delay instead. A fixed safe base gain is applied so mixing all
    // stems at once does not exceed a comfortable listening level regardless of
    // the sliders' state outside 3D.
    void set3DEnabled(bool e);
    // azimuthRad: 0=front, +pi/2=right, -pi/2=left, +/-pi=behind.
    // distance: meters (approx); 1.0 = base distance. Clamped to [0.1, +inf).
    // elevationDeg: -40..+90 (degrees). 0 = horizontal plane.
    void set3DPosition(float azimuthRad, float distance, float elevationDeg);
    // Omnipresent mode: the stem is heard "at the center" with no specific direction
    // (azimuth=0, distance=1 internally). Still routed through frontal HRTF to
    // preserve color, but without laterality.
    void set3DOmnipresent(bool o);
    // Per-stem mute inside 3D mode (independent from the user sliders). When
    // muted, apply3D / apply3D_Hrtf output silence for this stem.
    void set3DMuted(bool m);
    // Solo gate: silenced while another stem is soloed. Independent from the
    // user volume and from 3D; ramps over SOLO_RAMP_MS so toggling never clicks.
    void setSoloMuted(bool m){ mSoloMuted.store(m, std::memory_order_release); }
    // Engine-controlled "duck" multiplier (independent of the user volume).
    // Output_final = sample * mVolL/R * mEngineDuckMul. Atomic, lock-free.
    void  setEngineDuckMul(float m){ mEngineDuckMul.store(m, std::memory_order_release); }
    float getEngineDuckMul() const  { return mEngineDuckMul.load(std::memory_order_acquire); }
    // Recalibrates everything when Oboe reopens the stream with another device (BT, jack, etc.)
    void setDeviceSampleRate(int newDevSR);
    void seekToMs(int64_t ms);
    int64_t getCurrentPositionMs() const;
    int64_t getDurationMs() const;

    // Loudness envelope of the source: RMS in dBFS every ENVELOPE_HOP_MS,
    // computed once at load. Read-only afterwards.
    static constexpr int ENVELOPE_HOP_MS = 10;
    const std::vector<float>& getEnvelopeDb() const { return mEnvDb; }

    // True when tempo or pitch are outside the neutral values (1.0 / 0)
    bool hasNonNeutralPitchOrTempo() const {
        return std::fabs(mTempo.load() - 1.f) > 1e-3f
            || std::fabs(mPitch.load())      > 1e-3f;
    }

    // === Insert FX (filter + tempo echo) and reverb send. Not persisted. ===
    void setFxFilter(float amount)        { mFxFilter.setAmount(amount); }
    void setFxEcho(float amount, float delaySourceMs) {
        if (amount > 0.f) mFxEcho.prepare(mDevSR);
        mFxEcho.setDelaySourceMs(delaySourceMs);
        mFxEcho.setAmount(amount);
    }
    void  setReverbSend(float s)  { mReverbSend.store(std::max(0.f, s), std::memory_order_relaxed); }
    float getReverbSend() const   { return mReverbSend.load(std::memory_order_relaxed); }
    void  setReverbRoom(int r)    { mReverbRoom.store(std::clamp(r, 0, fx::Reverb::ROOMS - 1), std::memory_order_relaxed); }
    int   getReverbRoom() const   { return mReverbRoom.load(std::memory_order_relaxed); }

    // render
    // forceST: always run through SoundTouch even when tempo/pitch are neutral (keeps stems in sync)
    int render(float* outInterleaved, int32_t numFrames, bool forceST = false);

private:
    // WAV loader (PCM16 or IEEE float32)
    bool loadWavToFloat(const char* path);
    // Decodes FLAC via dr_flac (single-header) → float32 interleaved into mPcm.
    // WAV vs FLAC is picked by the path extension (.flac case-insensitive).
    bool loadFlacToFloat(const char* path);
    // Wrapper: decides WAV vs FLAC by extension.
    bool loadAudioToFloat(const char* path);

    // Generates resampled/upmixed frames to device SR and 2ch
    int generateResampled(int wantFrames, std::vector<float>& dst);

    // Applies the pending seek from the audio thread (lock-free)
    void applyPendingSeek();

    void computeEnvelope();
    std::vector<float> mEnvDb;

    // Filter then echo, on the stereo buffer before volume / 3D.
    void applyInsertFx(float* interleaved, int frames);
    fx::Filter mFxFilter;
    fx::Echo   mFxEcho;
    std::atomic<float> mReverbSend{0.f};
    std::atomic<int>   mReverbRoom{1};

    // track state
    std::vector<float> mPcm;   // interleaved source
    int mSrcSR   = 0;          // source sample rate
    int mSrcCh   = 0;          // source channels (1 or 2)

    // playback
    bool  mLoop  = false;
    std::atomic<bool> mEnded{false};

    // output (mDevSR can change when the output device changes → no longer const)
    int mDevSR;
    const int mOutCh; // 2

    // resampler (continuous state)
    double mSrcPos  = 0.0;     // position in source frames (fractional) — audio thread only
    double mSrcStep = 1.0;     // source-frame advance per output frame (srcSR/devSR)

    // UI <-> audio sync (lock-free)
    std::atomic<int64_t> mPendingSeekMs{INT64_MIN}; // INT64_MIN = no pending
    std::atomic<int64_t> mPositionMs{0};            // position published to the UI

    // controls
    std::atomic<float> mTempo{1.f};
    std::atomic<float> mPitch{0.f};
    std::atomic<float> mVolL{1.f};
    std::atomic<float> mVolR{1.f};
    // Engine-controlled multiplier for automatic ducking (the downbeat click ducks
    // the metronome). Independent of mVolL/R (controlled by the user via Java).
    std::atomic<float> mEngineDuckMul{1.f};

    // === 3D ITD/ILD mode (fallback) ===
    std::atomic<bool>  m3DEnabled{false};
    std::atomic<float> m3DAzimuth{0.f};    // radians
    std::atomic<float> m3DDistance{1.f};   // approx meters
    std::atomic<float> m3DElevation{0.f};  // degrees (-40..+90)
    std::atomic<bool>  m3DOmnipresent{false};
    // Independent 3D mute: not coupled to mVolL/R, so muting a stem in 3D does
    // not change the value shown by its normal slider outside 3D mode.
    std::atomic<bool>  m3DMuted{false};
    // Solo gate (see setSoloMuted). mSoloGain is the ramped gain, audio thread only.
    static constexpr float SOLO_RAMP_MS = 20.f;
    std::atomic<bool>  mSoloMuted{false};
    float mSoloGain = 1.f;
    void applySoloGate(float* interleaved, int frames);
    // Circular per-channel delay lines (fixed, generous size). 96 samples cover
    // >= 2ms at 48kHz — MORE than enough for the maximum ITD (~660us / ~32 samples).
    static constexpr int DELAY_BUF_SIZE = 128;
    std::vector<float> mDelayBufL, mDelayBufR;
    int mDelayWriteIdx = 0;
    // Applies delay + ILD + distance on the stereo interleaved buffer.
    // engineMul = current mEngineDuckMul (honors the click duck).
    void apply3D(float* interleaved, int frames, float engineMul);

    // === 3D HRTF (real) mode ===
    // Shared pointer to the HRIR bank; nullptr = unavailable → fallback to ITD/ILD.
    const HrtfBank* mHrtfBank = nullptr;
    // Mono input history (for 128-tap convolution). Size = hrirLength.
    std::vector<float> mHrtfHistory;
    int mHrtfHistoryWrite = 0;
    // "Current" HRIRs (mHrirL/R) and "prev" (for crossfade when the azimuth changes).
    std::vector<float> mHrirL, mHrirR;
    std::vector<float> mHrirL_prev, mHrirR_prev;
    // Remaining samples of the prev→current crossfade (0 = no crossfade).
    int   mHrtfCrossRemaining = 0;
    int   mHrtfCrossTotal     = 0;
    float mHrtfLastAzimuth    = 0.f;
    float mHrtfLastElevation  = 0.f;
    // Applies HRTF convolution on the stereo buffer. Reuses the same distance +
    // engineMul + userVol path as apply3D. Returns false when HRTF is unavailable.
    bool apply3D_Hrtf(float* interleaved, int frames, float engineMul);

public:
    /** Sets (or clears) the HRIR bank used in 3D mode. Shared across every
     *  track: the engine loads it once at startup and passes it to each new Track. */
    void setHrtfBank(const HrtfBank* b);

    // Cache of the last values applied to SoundTouch (avoids redundant calls
    // that can trigger internal recomputations and artifacts).
    float mLastStTempo = 1.f;
    float mLastStPitch = 0.f;
    // Track knows whether the previous render used ST to clear the buffer on re-enable.
    bool  mWasInST     = false;

    // SoundTouch
    soundtouch::SoundTouch mSt;
};
