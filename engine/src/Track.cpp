#include "Track.h"
#include <android/log.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <type_traits>

// dr_flac (single-header). The implementation is instantiated only here.
// STDIO enabled by default (DO NOT define DR_FLAC_NO_STDIO).
#define DR_FLAC_IMPLEMENTATION
#include "dr_flac.h"

#define TAG "Track"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)

// Make sure SoundTouch is using float
static_assert(std::is_same<soundtouch::SAMPLETYPE,float>::value,
              "Build SoundTouch with SOUNDTOUCH_FLOAT_SAMPLES=1");

Track::Track(const char* path, bool loop, int deviceSR, int outCh)
        : mLoop(loop), mDevSR(deviceSR), mOutCh(outCh) {
    if(!loadAudioToFloat(path)){
        LOGE("Could not load audio: %s", path);
        mEnded.store(true);
        return;
    }
    mSrcStep = (double)mSrcSR / (double)mDevSR; // source frames per output frame
    computeEnvelope();

    // 3D mode delay lines (fixed size, initialized to 0)
    mDelayBufL.assign(DELAY_BUF_SIZE, 0.f);
    mDelayBufR.assign(DELAY_BUF_SIZE, 0.f);

    // SoundTouch config — original, road-tested settings
    mSt.setSampleRate(mDevSR);
    mSt.setChannels(mOutCh);
    mSt.setSetting(SETTING_USE_QUICKSEEK, 1);
    mSt.setSetting(SETTING_SEQUENCE_MS,  40);
    mSt.setSetting(SETTING_SEEKWINDOW_MS,15);
    mSt.setSetting(SETTING_OVERLAP_MS,    8);
}

Track::~Track() = default;

void Track::computeEnvelope(){
    mEnvDb.clear();
    if (mSrcSR <= 0 || mSrcCh <= 0 || mPcm.empty()) return;
    const size_t frames = mPcm.size() / (size_t) mSrcCh;
    const size_t hop = std::max<size_t>(1, (size_t) mSrcSR * ENVELOPE_HOP_MS / 1000);
    mEnvDb.reserve(frames / hop + 1);
    for (size_t f0 = 0; f0 < frames; f0 += hop) {
        const size_t f1 = std::min(frames, f0 + hop);
        double acc = 0.0;
        for (size_t f = f0; f < f1; ++f) {
            float m = 0.f;
            for (int c = 0; c < mSrcCh; ++c) m += mPcm[f * mSrcCh + c];
            m /= (float) mSrcCh;
            acc += (double) m * m;
        }
        const double ms = acc / (double) (f1 - f0);
        mEnvDb.push_back((float) (10.0 * std::log10(ms + 1e-12)));
    }
}

void Track::setTempo(float t){ mTempo.store(std::clamp(t, 0.25f, 4.0f)); }
void Track::setPitch(float s){ mPitch.store(std::clamp(s,-24.f,24.f)); }
void Track::setVolumeLR(float L,float R){ mVolL.store(std::max(0.f,L)); mVolR.store(std::max(0.f,R)); }

void Track::set3DEnabled(bool e){
    bool prev = m3DEnabled.exchange(e, std::memory_order_acq_rel);
    if (prev != e) {
        // On toggle, clear delay buffers to avoid dragging stale samples
        // (prevents clicks when the mode or a drastic position change happens).
        std::fill(mDelayBufL.begin(), mDelayBufL.end(), 0.f);
        std::fill(mDelayBufR.begin(), mDelayBufR.end(), 0.f);
        mDelayWriteIdx = 0;
    }
}
void Track::set3DPosition(float azimuthRad, float distance, float elevationDeg){
    m3DAzimuth.store(azimuthRad, std::memory_order_release);
    m3DDistance.store(std::max(0.1f, distance), std::memory_order_release);
    m3DElevation.store(std::clamp(elevationDeg, -40.f, 90.f), std::memory_order_release);
}

void Track::set3DOmnipresent(bool o){
    m3DOmnipresent.store(o, std::memory_order_release);
}

void Track::set3DMuted(bool m){
    m3DMuted.store(m, std::memory_order_release);
}

void Track::applySoloGate(float* buf, int frames){
    const float target = mSoloMuted.load(std::memory_order_acquire) ? 0.f : 1.f;
    if (mSoloGain == target) {
        if (target == 0.f) std::fill_n(buf, frames * mOutCh, 0.f);
        return;
    }
    // Linear ramp toward the target, then hold.
    const float step = 1000.f / (SOLO_RAMP_MS * (float)std::max(1, mDevSR));
    for (int i = 0; i < frames; ++i) {
        mSoloGain = target > mSoloGain ? std::min(target, mSoloGain + step)
                                       : std::max(target, mSoloGain - step);
        buf[2 * i]     *= mSoloGain;
        buf[2 * i + 1] *= mSoloGain;
    }
}

void Track::setHrtfBank(const HrtfBank* b){
    mHrtfBank = b;
    if (b && b->isLoaded()) {
        int n = b->hrirLength();
        mHrtfHistory.assign(n, 0.f);
        mHrtfHistoryWrite = 0;
        mHrirL.assign(n, 0.f);
        mHrirR.assign(n, 0.f);
        mHrirL_prev.assign(n, 0.f);
        mHrirR_prev.assign(n, 0.f);
        mHrtfCrossRemaining = 0;
        mHrtfCrossTotal     = 0;
        mHrtfLastAzimuth    = 1e9f; // absurd value to force the first sampling
    }
}

void Track::setDeviceSampleRate(int newDevSR){
    if (newDevSR <= 0 || newDevSR == mDevSR) return;
    mDevSR   = newDevSR;
    mSrcStep = (double)mSrcSR / (double)mDevSR;
    mSt.setSampleRate(mDevSR);
    mSt.clear();
    mWasInST = false;
}

void Track::seekToMs(int64_t ms){
    if(mSrcSR<=0) return;
    // Only enqueues: the audio thread applies it at the start of the render
    mPendingSeekMs.store(ms, std::memory_order_release);
}

void Track::applyPendingSeek(){
    int64_t ms = mPendingSeekMs.exchange(INT64_MIN, std::memory_order_acq_rel);
    if (ms == INT64_MIN) return;
    double srcFrame = (double)ms * (double)mSrcSR / 1000.0;
    double maxPos = std::max(0.0, (double)mPcm.size()/std::max(1,mSrcCh) - 1.0);
    mSrcPos = std::clamp(srcFrame, 0.0, maxPos);
    mEnded.store(false, std::memory_order_release);
    mSt.clear();
    // ST FIFO empty: force warmup on the next render (identical on every
    // track → they stay in sync after a seek + ST active).
    mWasInST = false;
    mPositionMs.store(ms, std::memory_order_release);
}

int64_t Track::getCurrentPositionMs() const{
    return mPositionMs.load(std::memory_order_acquire);
}

int64_t Track::getDurationMs() const {
    if (mSrcSR <= 0) return 0;
    int totalFrames = (int)mPcm.size() / std::max(1, mSrcCh);
    return (int64_t) llround((double) totalFrames * 1000.0 / (double) mSrcSR);
}

void Track::applyInsertFx(float* buf, int frames){
    if (frames <= 0) return;
    if (mFxFilter.isActive()) mFxFilter.process(buf, frames, mDevSR);
    if (mFxEcho.isActive())   mFxEcho.process(buf, frames, mDevSR, mTempo.load(std::memory_order_relaxed));
}

// Main render: returns frames written (<= numFrames)
int Track::render(float* out, int32_t numFrames, bool forceST){
    // Apply any pending seek from the UI thread
    applyPendingSeek();

    if(mEnded.load(std::memory_order_acquire) || mSrcSR==0) { std::fill_n(out, numFrames*mOutCh, 0.f); return numFrames; }

    const float tempo = mTempo.load();
    const float pitch = mPitch.load();
    // ST only when required. In passthrough it degrades quality (WSOLA splicing).
    // forceST is set from AudioEngine when any track has non-neutral pitch/tempo:
    // that way every track shares the same latency and stems stay synchronized.
    const bool useST = forceST || (std::fabs(tempo-1.f) > 1e-3f) || (std::fabs(pitch) > 1e-3f);

    // Generate at device SR
    static thread_local std::vector<float> res; res.clear();

    if(!useST){
        // Leaving ST: flag it so the next activation clears the buffer
        if (mWasInST) { mWasInST = false; }
        int got = generateResampled(numFrames, res);
        applyInsertFx(res.data(), got);
        const float dm = mEngineDuckMul.load(std::memory_order_acquire);
        if (m3DEnabled.load(std::memory_order_acquire)) {
            // Copy and apply 3D directly on out
            std::copy_n(res.data(), got*mOutCh, out);
            // Prefer HRTF when available; fallback to ITD/ILD otherwise
            if (!apply3D_Hrtf(out, got, dm)) apply3D(out, got, dm);
        } else {
            const float L = mVolL.load() * dm, R = mVolR.load() * dm;
            for(int i=0;i<got;i++){ out[2*i+0] = res[2*i+0]*L; out[2*i+1] = res[2*i+1]*R; }
        }
        applySoloGate(out, got);
        if(got < numFrames){ std::fill(out+2*got, out+2*numFrames, 0.f); }
        mPositionMs.store((int64_t) llround(mSrcPos * 1000.0 / (double)mSrcSR),
                          std::memory_order_release);
        return numFrames;
    }

    // Apply settings if they changed (before any put/receive)
    if (std::fabs(tempo - mLastStTempo) > 1e-4f) {
        mSt.setTempo(tempo);
        mLastStTempo = tempo;
    }
    if (std::fabs(pitch - mLastStPitch) > 1e-4f) {
        mSt.setPitchSemiTones(pitch);
        mLastStPitch = pitch;
    }

    // Entering ST after being out: clear the old buffer and pre-fill so the
    // first receive can already spit out numFrames without gaps.
    if (!mWasInST) {
        mSt.clear();
        mSt.setTempo(tempo);
        mSt.setPitchSemiTones(pitch);
        mWasInST = true;
        // Pre-warmup: enough input for ST's internal latency (~200ms). With
        // SEQUENCE_MS=82 + SEEKWINDOW=28 + overlap, more cushion is needed.
        int warmInput = (int) std::ceil(numFrames * (double) tempo)
                      + (mDevSR / 5); // +200ms cushion
        int gen = generateResampled(warmInput, res);
        if (gen > 0) mSt.putSamples(res.data(), gen);
    }

    int produced = 0;
    static thread_local std::vector<float> stTmp; stTmp.resize(numFrames * mOutCh);

    // Normal loop: feed only what is needed to avoid accumulated drift between stems.
    for(int guard = 0; produced < numFrames && guard < 8; ++guard){
        int want  = numFrames - produced;
        int avail = (int) mSt.numSamples();

        if (avail < want) {
            int outputMissing = want - avail;
            int chunkInput = (int)(std::ceil(outputMissing * (double) tempo)) + 256;
            int gen = generateResampled(chunkInput, res);
            if (gen > 0) mSt.putSamples(res.data(), gen);
            else if (mEnded.load(std::memory_order_acquire)) {
                mSt.flush();
                break;
            }
        }

        int got = mSt.receiveSamples(stTmp.data() + produced*mOutCh, want);
        produced += got;
        if (got == 0 && mEnded.load(std::memory_order_acquire)) break;
    }

    // When the buffer is still not full, pad with zeros (last resort)
    if (produced < numFrames) {
        std::fill(stTmp.data() + produced*mOutCh,
                  stTmp.data() + numFrames*mOutCh, 0.f);
        produced = numFrames;
    }

    applyInsertFx(stTmp.data(), produced);

    // apply volume (user × engine duck) or 3D mode (real HRTF when present, ITD/ILD otherwise)
    const float dm = mEngineDuckMul.load(std::memory_order_acquire);
    if (m3DEnabled.load(std::memory_order_acquire)) {
        if (!apply3D_Hrtf(stTmp.data(), produced, dm)) apply3D(stTmp.data(), produced, dm);
    } else {
        const float L = mVolL.load() * dm, R = mVolR.load() * dm;
        for(int i=0;i<produced;i++){ stTmp[2*i+0] *= L; stTmp[2*i+1] *= R; }
    }
    applySoloGate(stTmp.data(), produced);

    // copy to out and pad with zeros if missing
    std::copy_n(stTmp.data(), produced*mOutCh, out);
    if(produced < numFrames) std::fill(out + produced*mOutCh, out + numFrames*mOutCh, 0.f);
    // Publish position to the UI
    mPositionMs.store((int64_t) llround(mSrcPos * 1000.0 / (double)mSrcSR),
                      std::memory_order_release);
    return numFrames;
}

// ------------------------------------------------------------
// 3D mode: ITD (Interaural Time Difference) + ILD (Interaural Level Difference)
// + distance attenuation. Simplified Woodworth model.
//   - HEAD_RADIUS  = 0.0875 m (average adult human head radius)
//   - SOUND_SPEED  = 343 m/s
//   - ITD = (r/c) * (theta + sin(theta))  ~ 660 us max (at 90 degrees)
//   - ILD: acoustic shadow on the far ear when the source is lateral.
//         Approximated as linear attenuation with sin(|az|).
//   - Distance: gain = clamp(1/max(d,MIN), MAX). No distance-dependent low-pass
//     filtering yet — future feature for a more realistic "far away" feel.
// The fractional delay uses linear interpolation on the circular buffer.
// ------------------------------------------------------------
void Track::apply3D(float* buf, int frames, float engineMul){
    static constexpr float HEAD_RADIUS  = 0.0875f;   // metros
    static constexpr float SOUND_SPEED  = 343.f;     // m/s
    static constexpr float MIN_DIST     = 0.5f;
    static constexpr float MAX_DIST_GAIN = 2.f;
    static constexpr float PI_F         = 3.14159265358979323846f;

    // Atomic parameter snapshot — read at the start of the block
    float az = m3DAzimuth.load(std::memory_order_acquire);
    float d  = std::max(MIN_DIST, m3DDistance.load(std::memory_order_acquire));

    // Wrap azimuth to [-pi, pi] and work with |az| in the formula.
    while (az >  PI_F) az -= 2.f * PI_F;
    while (az < -PI_F) az += 2.f * PI_F;
    float absAz = std::fabs(az);
    // The Woodworth formula (r/c)(θ+sin(θ)) is designed for |θ| ∈ [0, π/2].
    // It is reflected at π/2 so ITD goes back to 0 at |az|=π (source behind),
    // which is physically correct (both ears equidistant). With this, front and
    // back are perceptually identical — the "cone of confusion" still exists,
    // but at least the ITD is not falsified with exaggerated values.
    if (absAz > PI_F * 0.5f) absAz = PI_F - absAz;
    float itdSec = (HEAD_RADIUS / SOUND_SPEED) * (absAz + std::sin(absAz));
    float delaySamples = itdSec * (float)mDevSR;
    // Per-channel delay: the "far" ear receives with a delay.
    float delayL = 0.f, delayR = 0.f;
    if (az > 0.f)      delayL = delaySamples;   // source on the right
    else if (az < 0.f) delayR = delaySamples;   // source on the left

    // ILD: progressive attenuation of the shadowed ear. At 0 rad: gain=1 on both.
    // At +/- pi/2: near=1.0, far ~ 0.55. Smoothed with sin(|az|).
    float shadow  = std::sin(absAz);
    float gainFar = 1.f - 0.45f * shadow;
    float gL = 1.f, gR = 1.f;
    if (az > 0.f)      gL = gainFar;
    else if (az < 0.f) gR = gainFar;

    // Distance: 1/r with floor and ceiling to avoid clipping when very close.
    float distGain = std::min(MAX_DIST_GAIN, 1.f / d);
    gL *= distGain * engineMul;
    gR *= distGain * engineMul;
    // Fixed safe base gain so 3D mode is decoupled from the user sliders.
    // BASE_GAIN_3D matches the default slider (75%) to keep a comfortable
    // reference level across the mix even when many stems are present.
    static constexpr float BASE_GAIN_3D = 0.75f;
    float base = m3DMuted.load(std::memory_order_acquire) ? 0.f : BASE_GAIN_3D;
    gL *= base;
    gR *= base;

    const int N = (int)mDelayBufL.size();
    for (int i = 0; i < frames; ++i) {
        float inL = buf[2*i+0];
        float inR = buf[2*i+1];
        // Write into the delay lines
        mDelayBufL[mDelayWriteIdx] = inL;
        mDelayBufR[mDelayWriteIdx] = inR;

        // Read with fractional delay (linear interpolation)
        auto tap = [&](const std::vector<float>& db, float delay) -> float {
            float readPos = (float)mDelayWriteIdx - delay;
            while (readPos < 0.f) readPos += (float)N;
            int i0 = (int)std::floor(readPos);
            int i1 = i0 + 1;
            float frac = readPos - (float)i0;
            if (i0 >= N) i0 -= N;
            if (i1 >= N) i1 -= N;
            return db[i0] * (1.f - frac) + db[i1] * frac;
        };
        buf[2*i+0] = tap(mDelayBufL, delayL) * gL;
        buf[2*i+1] = tap(mDelayBufR, delayR) * gR;

        mDelayWriteIdx = (mDelayWriteIdx + 1) % N;
    }
}

// ------------------------------------------------------------
// 3D mode with real HRTF (Head-Related Transfer Function).
// 128-tap convolution of the mono input with the L/R HRIRs linearly interpolated
// between the 2 neighboring azimuths of HrtfBank. When the position changes, a
// crossfade of mHrtfCrossTotal samples between the previous and the new HRIR
// avoids clicks (otherwise each position change would inject an impulse).
// Distance + engineMul + BASE_GAIN_3D are applied at the end, same as apply3D.
// Returns true when HRTF is available; false otherwise (caller falls back to apply3D).
// ------------------------------------------------------------
bool Track::apply3D_Hrtf(float* buf, int frames, float engineMul){
    if (!mHrtfBank || !mHrtfBank->isLoaded()) return false;
    const int N = mHrtfBank->hrirLength();
    if (N <= 0) return false;

    // Positioning parameters
    bool  omni   = m3DOmnipresent.load(std::memory_order_acquire);
    float az     = omni ? 0.f : m3DAzimuth.load(std::memory_order_acquire);
    float d      = omni ? 1.f : std::max(0.5f, m3DDistance.load(std::memory_order_acquire));
    float elev   = omni ? 0.f : m3DElevation.load(std::memory_order_acquire);
    float distGain = std::min(2.f, 1.f / d);
    // Independent 3D gain: user sliders ignored, mute goes through m3DMuted.
    static constexpr float BASE_GAIN_3D = 0.75f;
    float base     = m3DMuted.load(std::memory_order_acquire) ? 0.f : BASE_GAIN_3D;
    float overall  = distGain * engineMul * base;

    // Change threshold: when azimuth OR elev moved more than its threshold,
    // resample the new HRIR and start the crossfade. Otherwise the HRIR would be
    // rebuilt every sample.
    constexpr float AZ_CHANGE_THR   = 0.010f;  // ~0.6°
    constexpr float ELEV_CHANGE_THR = 1.0f;    // 1°
    bool azChanged  = std::fabs(az   - mHrtfLastAzimuth)   > AZ_CHANGE_THR;
    bool elevChanged= std::fabs(elev - mHrtfLastElevation) > ELEV_CHANGE_THR;
    if (azChanged || elevChanged) {
        std::memcpy(mHrirL_prev.data(), mHrirL.data(), sizeof(float) * N);
        std::memcpy(mHrirR_prev.data(), mHrirR.data(), sizeof(float) * N);
        mHrtfBank->sampleInterpolated(az, elev, mHrirL.data(), mHrirR.data());
        mHrtfCrossTotal     = 64;
        mHrtfCrossRemaining = mHrtfCrossTotal;
        mHrtfLastAzimuth    = az;
        mHrtfLastElevation  = elev;
    } else if (mHrtfLastAzimuth > 1e8f) {
        // First render: no previous HRIR
        mHrtfBank->sampleInterpolated(az, elev, mHrirL.data(), mHrirR.data());
        std::memcpy(mHrirL_prev.data(), mHrirL.data(), sizeof(float) * N);
        std::memcpy(mHrirR_prev.data(), mHrirR.data(), sizeof(float) * N);
        mHrtfLastAzimuth   = az;
        mHrtfLastElevation = elev;
    }

    // Sample-by-sample convolution
    for (int i = 0; i < frames; ++i) {
        float mono = 0.5f * (buf[2*i+0] + buf[2*i+1]);
        // Write into the circular history
        mHrtfHistory[mHrtfHistoryWrite] = mono;
        // Convolution with the new HRIR
        float sumLnew = 0.f, sumRnew = 0.f;
        int idx = mHrtfHistoryWrite;
        for (int k = 0; k < N; ++k) {
            sumLnew += mHrtfHistory[idx] * mHrirL[k];
            sumRnew += mHrtfHistory[idx] * mHrirR[k];
            idx--;
            if (idx < 0) idx += N;
        }
        float outL = sumLnew, outR = sumRnew;
        // Crossfade with the previous HRIR
        if (mHrtfCrossRemaining > 0) {
            float sumLp = 0.f, sumRp = 0.f;
            idx = mHrtfHistoryWrite;
            for (int k = 0; k < N; ++k) {
                sumLp += mHrtfHistory[idx] * mHrirL_prev[k];
                sumRp += mHrtfHistory[idx] * mHrirR_prev[k];
                idx--;
                if (idx < 0) idx += N;
            }
            float frac = (float) mHrtfCrossRemaining / (float) mHrtfCrossTotal; // 1..0
            outL = sumLp * frac + sumLnew * (1.f - frac);
            outR = sumRp * frac + sumRnew * (1.f - frac);
            mHrtfCrossRemaining--;
        }
        buf[2*i+0] = outL * overall;
        buf[2*i+1] = outR * overall;
        mHrtfHistoryWrite++;
        if (mHrtfHistoryWrite >= N) mHrtfHistoryWrite = 0;
    }
    return true;
}

// Generates 'wantFrames' at device SR, upmixed to 2ch, updating mSrcPos
int Track::generateResampled(int wantFrames, std::vector<float>& dst){
    dst.resize(wantFrames * mOutCh);
    const int totalSrcFrames = (int)mPcm.size() / std::max(1,mSrcCh);

    for(int i=0;i<wantFrames;i++){
        if(mSrcPos >= totalSrcFrames - 1){
            if(mLoop){
                // Wrap to the start. fmod(x, N) with x < N was a no-op → prior bug.
                mSrcPos = 0.0;
            } else {
                mEnded.store(true, std::memory_order_release);
                std::fill(dst.begin()+i*mOutCh, dst.end(), 0.f);
                return wantFrames;
            }
        }
        int i0 = (int)std::floor(mSrcPos);
        int i1 = i0 + 1;
        // Defensive clamp in case mSrcPos reaches the edge (safe read)
        if (i0 < 0) i0 = 0;
        if (i1 >= totalSrcFrames) i1 = totalSrcFrames - 1;
        if (i0 > i1) i0 = i1;
        double frac = mSrcPos - (double)i0;

        float L0, R0, L1, R1;
        if(mSrcCh == 2){
            L0 = mPcm[2*i0+0]; R0 = mPcm[2*i0+1];
            L1 = mPcm[2*i1+0]; R1 = mPcm[2*i1+1];
        } else { // mono → stereo
            L0 = R0 = mPcm[i0];
            L1 = R1 = mPcm[i1];
        }
        // Per-channel linear interpolation
        dst[2*i+0] = (float)(L0 + (L1 - L0) * frac);
        dst[2*i+1] = (float)(R0 + (R1 - R0) * frac);

        mSrcPos += mSrcStep;
    }
    return wantFrames;
}

// ------------------------------------------------------------
// Simple WAV (PCM16 or IEEE float32 LE)
// ------------------------------------------------------------
#pragma pack(push,1)
struct RiffHeader { char riff[4]; uint32_t size; char wave[4]; };
struct ChunkHeader{ char id[4];   uint32_t size; };
struct FmtChunk  { uint16_t format; uint16_t channels; uint32_t sampleRate; uint32_t byteRate; uint16_t blockAlign; uint16_t bitsPerSample; };
#pragma pack(pop)

static inline bool idEq4(const char id[4], const char* s){ return std::memcmp(id,s,4)==0; }

bool Track::loadWavToFloat(const char* path){
    mPcm.clear(); mSrcSR=0; mSrcCh=0; mSrcPos=0; mEnded.store(false);
    FILE* f = std::fopen(path, "rb");
    if(!f){ LOGE("fopen failed: %s", path); return false; }

    RiffHeader rh{}; if(std::fread(&rh,1,sizeof(rh),f)!=sizeof(rh)){ std::fclose(f); return false; }
    if(!idEq4(rh.riff,"RIFF") || !idEq4(rh.wave,"WAVE")){ LOGE("No RIFF/WAVE: %s", path); std::fclose(f); return false; }

    uint16_t fmt=0, ch=0, bps=0; uint32_t sr=0; uint32_t dataSize=0; long dataPos=0;
    while(true){
        ChunkHeader chdr{}; if(std::fread(&chdr,1,sizeof(chdr),f)!=sizeof(chdr)) break;
        if(idEq4(chdr.id,"fmt ")){
            FmtChunk fc{}; size_t n = std::fread(&fc,1,std::min<uint32_t>(chdr.size,sizeof(fc)),f);
            if(n < 16){ std::fclose(f); return false; }
            fmt = fc.format; ch = fc.channels; sr = fc.sampleRate; bps = fc.bitsPerSample;
            long remaining = (long)chdr.size - (long)n;
            // WAVE_FORMAT_EXTENSIBLE (0xFFFE): the real format lives in the first 2 bytes
            // of the SubFormat GUID. Layout after the standard 16 bytes:
            //   cbSize (2) | validBitsPerSample (2) | channelMask (4) | SubFormat GUID (16)
            // Only the first 2 bytes of the GUID matter (offset +8 inside the extra).
            if (fmt == 0xFFFE && remaining >= 10) {
                uint16_t cbSize = 0;
                std::fread(&cbSize, 1, 2, f); remaining -= 2;
                if (cbSize >= 22 && remaining >= 22) {
                    // Skip validBitsPerSample (2) + channelMask (4) = 6 bytes
                    std::fseek(f, 6, SEEK_CUR); remaining -= 6;
                    uint16_t guidFmt = 0;
                    std::fread(&guidFmt, 1, 2, f); remaining -= 2;
                    // 0x0001 = PCM, 0x0003 = IEEE float
                    if (guidFmt == 1 || guidFmt == 3) fmt = guidFmt;
                }
            }
            if (remaining > 0) std::fseek(f, remaining, SEEK_CUR);
        } else if(idEq4(chdr.id,"data")){
            dataSize = chdr.size; dataPos = std::ftell(f); std::fseek(f, chdr.size, SEEK_CUR);
        } else { std::fseek(f, chdr.size, SEEK_CUR); }
        if((chdr.size & 1) != 0) std::fseek(f, 1, SEEK_CUR); // 2-byte alignment
    }

    if(fmt==0 || dataPos==0){ LOGE("WAV missing fmt/data: %s", path); std::fclose(f); return false; }
    if(!(fmt==1 || fmt==3)) { LOGE("unsupported fmt: %u", fmt); std::fclose(f); return false; }
    if(!(ch==1 || ch==2))  { LOGE("unsupported channels: %u", ch); std::fclose(f); return false; }
    if(sr < 8000 || sr > 384000) { LOGE("unsupported sample rate: %u", sr); std::fclose(f); return false; }
    // The data chunk can only be as large as what follows it in the file
    // (streamed WAVs write 0xFFFFFFFF): never allocate past the real size.
    std::fseek(f, 0, SEEK_END);
    const long fileEnd = std::ftell(f);
    if (fileEnd <= dataPos) { LOGE("WAV without audio data: %s", path); std::fclose(f); return false; }
    if ((uint64_t) dataSize > (uint64_t) (fileEnd - dataPos)) dataSize = (uint32_t) (fileEnd - dataPos);
    // Supported: PCM16, PCM24, PCM32, IEEE float32
    if(!( (fmt==1 && (bps==16 || bps==24 || bps==32)) || (fmt==3 && bps==32) )){
        LOGE("unsupported bps/fmt: fmt=%u bps=%u", fmt, bps); std::fclose(f); return false;
    }

    std::vector<uint8_t> raw(dataSize);
    std::fseek(f, dataPos, SEEK_SET);
    if(std::fread(raw.data(),1,raw.size(),f)!=raw.size()){ std::fclose(f); return false; }
    std::fclose(f);

    const size_t bytesPerSample = bps/8;
    const size_t frames = dataSize / (bytesPerSample * ch);
    if (frames == 0) { LOGE("WAV without audio data: %s", path); return false; }
    mPcm.resize(frames * ch);

    if(fmt==1 && bps==16){
        const int16_t* p = reinterpret_cast<const int16_t*>(raw.data());
        for(size_t i=0;i<frames*ch;++i) mPcm[i] = (float)p[i] / 32768.f;
    } else if(fmt==1 && bps==24){
        // PCM 24-bit signed little-endian
        for(size_t i=0;i<frames*ch;++i){
            int32_t v = (int32_t) ((uint32_t)raw[i*3+0]
                                 | ((uint32_t)raw[i*3+1] << 8)
                                 | ((uint32_t)raw[i*3+2] << 16));
            if (v & 0x00800000) v |= 0xFF000000; // sign-extend
            mPcm[i] = (float)v / 8388608.f; // 2^23
        }
    } else if(fmt==1 && bps==32){
        // PCM 32-bit signed little-endian
        const int32_t* p = reinterpret_cast<const int32_t*>(raw.data());
        for(size_t i=0;i<frames*ch;++i) mPcm[i] = (float)p[i] / 2147483648.f; // 2^31
    } else { // float32 (fmt==3 && bps==32)
        const float* p = reinterpret_cast<const float*>(raw.data());
        std::memcpy(mPcm.data(), p, frames*ch*sizeof(float));
    }

    mSrcSR = (int)sr; mSrcCh = (int)ch;
    LOGI("WAV ok: %s SR=%d ch=%d frames=%zu bps=%u", path, mSrcSR, mSrcCh, frames, bps);
    return true;
}

// -------------------- FLAC (dr_flac) --------------------

bool Track::loadFlacToFloat(const char* path){
    mPcm.clear(); mSrcSR=0; mSrcCh=0; mSrcPos=0; mEnded.store(false);
    unsigned int channels = 0, sampleRate = 0;
    drflac_uint64 totalFrames = 0;
    // Returns float32 interleaved [-1,1] already normalized — same layout as mPcm.
    float* samples = drflac_open_file_and_read_pcm_frames_f32(
            path, &channels, &sampleRate, &totalFrames, nullptr);
    if (!samples) { LOGE("FLAC decode failed: %s", path); return false; }
    if (!(channels == 1 || channels == 2) || sampleRate < 8000 || sampleRate > 384000
            || totalFrames == 0) {
        LOGE("FLAC unsupported: ch=%u sr=%u frames=%llu", channels, sampleRate,
             (unsigned long long) totalFrames);
        drflac_free(samples, nullptr);
        return false;
    }
    const size_t total = (size_t)totalFrames * (size_t)channels;
    mPcm.assign(samples, samples + total);
    drflac_free(samples, nullptr);
    mSrcSR = (int)sampleRate; mSrcCh = (int)channels;
    LOGI("FLAC ok: %s SR=%d ch=%d frames=%llu", path, mSrcSR, mSrcCh,
         (unsigned long long)totalFrames);
    return true;
}

bool Track::loadAudioToFloat(const char* path){
    // Detects the extension (case-insensitive) at the end of the path.
    if (!path) return false;
    size_t n = std::strlen(path);
    auto endsWithCI = [&](const char* ext) {
        size_t el = std::strlen(ext);
        if (n < el) return false;
        for (size_t i=0; i<el; ++i) {
            char a = path[n-el+i], b = ext[i];
            if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
            if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
            if (a != b) return false;
        }
        return true;
    };
    if (endsWithCI(".flac")) return loadFlacToFloat(path);
    // Default (includes .wav): existing WAV loader.
    return loadWavToFloat(path);
}
