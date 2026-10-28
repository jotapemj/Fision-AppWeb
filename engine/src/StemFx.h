#pragma once
// Per-stem insert effects (filter, tempo echo) and the shared reverb bus.
// Parameters are atomics written from Java; state is touched only by the
// thread that processes (the audio callback, or the offline export worker).
#include <atomic>
#include <vector>
#include <cmath>
#include <cstring>
#include <algorithm>

namespace fx {

// ---------------------------------------------------------------------------
// Bipolar filter: amount in [-1, 1]. 0 = bypass, negative = low-pass sweeping
// down from 20 kHz to 200 Hz, positive = high-pass sweeping up from 20 Hz to
// 15 kHz. Topology-preserving state-variable filter (stable under modulation),
// fixed gentle resonance. The amount is smoothed so sweeps do not zipper.
// ---------------------------------------------------------------------------
class Filter {
public:
    void setAmount(float a){ mTarget.store(std::clamp(a, -1.f, 1.f), std::memory_order_relaxed); }
    bool isActive() const { return mTarget.load(std::memory_order_relaxed) != 0.f || mActive; }

    void process(float* buf, int frames, int sr){
        const float target = mTarget.load(std::memory_order_relaxed);
        if (!mActive) {
            if (target == 0.f) return;
            mActive = true;
            mS = 0.f;
            mIc1[0] = mIc1[1] = mIc2[0] = mIc2[1] = 0.f;
        }
        constexpr int BLOCK = 16;
        const float coef = 1.f - std::exp(-(float)BLOCK / (0.04f * (float)sr));
        for (int start = 0; start < frames; start += BLOCK) {
            const int n = std::min(BLOCK, frames - start);
            mS += (target - mS) * coef;
            if (target == 0.f && std::fabs(mS) < 0.002f) { mActive = false; return; }
            const float a = std::fabs(mS);
            const bool high = mS > 0.f;
            float fc = high ? 20.f * std::pow(750.f, a) : 20000.f * std::pow(0.01f, a);
            fc = std::min(fc, 0.45f * (float)sr);
            const float g  = std::tan((float)M_PI * fc / (float)sr);
            const float k  = 1.0f;                 // Q = 1: soft resonance
            const float a1 = 1.f / (1.f + g * (g + k));
            const float a2 = g * a1;
            const float a3 = g * a2;
            float* p = buf + 2 * start;
            for (int i = 0; i < n; ++i) {
                for (int c = 0; c < 2; ++c) {
                    const float v0 = p[2 * i + c];
                    const float v3 = v0 - mIc2[c];
                    const float v1 = a1 * mIc1[c] + a2 * v3;
                    const float v2 = mIc2[c] + a2 * mIc1[c] + a3 * v3;
                    mIc1[c] = 2.f * v1 - mIc1[c];
                    mIc2[c] = 2.f * v2 - mIc2[c];
                    p[2 * i + c] = high ? (v0 - k * v1 - v2) : v2;
                }
            }
        }
    }

    void reset(){ mActive = false; mS = 0.f; }

private:
    std::atomic<float> mTarget{0.f};
    bool  mActive = false;
    float mS = 0.f;
    float mIc1[2] = {0.f, 0.f};
    float mIc2[2] = {0.f, 0.f};
};

// ---------------------------------------------------------------------------
// Tempo echo. The delay is given in SOURCE milliseconds (a beat division at
// the original tempo) and divided by the playback tempo, so the repeats stay
// on the beat when the song is slowed down or sped up. The amount drives the
// send into the delay line and the feedback together; the feedback holds its
// last value when the amount drops to 0 so the tail decays naturally. The
// line is allocated lazily (from a control thread) on first use.
// ---------------------------------------------------------------------------
class Echo {
public:
    static constexpr float MAX_DELAY_S = 4.5f;

    /** Allocates the delay line. Control thread only, before enabling. */
    void prepare(int sr){
        if (mReady.load(std::memory_order_acquire)) return;
        const int frames = (int)(MAX_DELAY_S * (float)std::max(sr, 48000)) + 4;
        mBuf.assign((size_t)frames * 2, 0.f);
        mLen = frames;
        mReady.store(true, std::memory_order_release);
    }
    void setAmount(float a){ mTarget.store(std::clamp(a, 0.f, 1.f), std::memory_order_relaxed); }
    void setDelaySourceMs(float ms){ mDelaySrcMs.store(std::max(10.f, ms), std::memory_order_relaxed); }
    bool isActive() const { return mTarget.load(std::memory_order_relaxed) > 0.f || mActive; }

    void process(float* buf, int frames, int sr, float tempo){
        if (!mReady.load(std::memory_order_acquire)) return;
        const float target = mTarget.load(std::memory_order_relaxed);
        if (!mActive) {
            if (target <= 0.f) return;
            mActive = true;
            mQuiet = 0;
            mAmt = 0.f;
            mDelay = -1.f;
        }
        if (target > 0.f) mFbAmt = target;
        const float fb  = 0.25f + 0.45f * mFbAmt;
        const float wet = 0.75f;
        float wantDelay = mDelaySrcMs.load(std::memory_order_relaxed) * 0.001f
                          * (float)sr / std::max(0.25f, tempo);
        if (!(wantDelay >= 1.f)) wantDelay = 1.f;   // also NaN, which clamp lets through
        wantDelay = std::clamp(wantDelay, 1.f, (float)(mLen - 3));
        if (mDelay < 0.f) mDelay = wantDelay;
        const float amtCoef   = 1.f - std::exp(-1.f / (0.03f * (float)sr));
        const float delayCoef = 1.f - std::exp(-1.f / (0.08f * (float)sr));
        float peak = 0.f;
        for (int i = 0; i < frames; ++i) {
            mAmt   += (target - mAmt) * amtCoef;
            mDelay += (wantDelay - mDelay) * delayCoef;
            // Double: in float, a tiny negative position plus mLen rounds to
            // mLen itself, one frame past the end of the line.
            double rp = (double)mW - (double)mDelay;
            if (rp < 0.0) rp += (double)mLen;
            int r0 = (int)rp;
            if (r0 >= mLen) { r0 -= mLen; rp -= (double)mLen; }
            if (r0 < 0) { r0 = 0; rp = 0.0; }
            const int   r1 = (r0 + 1) % mLen;
            const float fr = (float)(rp - (double)r0);
            for (int c = 0; c < 2; ++c) {
                const float y = mBuf[2 * r0 + c] + (mBuf[2 * r1 + c] - mBuf[2 * r0 + c]) * fr;
                // Darker repeats: one-pole low-pass in the feedback path.
                mLp[c] += (y - mLp[c]) * 0.45f;
                const float x = buf[2 * i + c];
                mBuf[2 * mW + c] = x * mAmt + mLp[c] * fb;
                buf[2 * i + c] = x + y * wet;
                peak = std::max(peak, std::fabs(y));
            }
            if (++mW >= mLen) mW = 0;
        }
        // Goes idle once the amount is 0 and the line has been silent for a
        // whole delay period (nothing left to repeat).
        if (target <= 0.f && mAmt < 1e-4f) {
            mQuiet = peak < 1e-5f ? mQuiet + frames : 0;
            if (mQuiet > (int)mDelay + frames) {
                std::fill(mBuf.begin(), mBuf.end(), 0.f);
                mLp[0] = mLp[1] = 0.f;
                mActive = false;
            }
        }
    }

private:
    std::atomic<bool>  mReady{false};
    std::atomic<float> mTarget{0.f};
    std::atomic<float> mDelaySrcMs{500.f};
    std::vector<float> mBuf;
    int   mLen = 0;
    int   mW = 0;
    bool  mActive = false;
    int   mQuiet = 0;
    float mAmt = 0.f;
    float mFbAmt = 0.f;
    float mDelay = -1.f;
    float mLp[2] = {0.f, 0.f};
};

// ---------------------------------------------------------------------------
// Shared reverb (Freeverb topology: 8 parallel damped combs + 4 series
// allpasses per channel). One instance per room size; stems feed the room
// they pick through a post-fader send and the engine adds the wet output to
// the mix. Linear and time-invariant, so the offline export can run it per
// stem and sum.
// ---------------------------------------------------------------------------
class Reverb {
public:
    static constexpr int ROOMS = 3;   // small, medium, large

    explicit Reverb(int room = 1){ setRoom(room); setSampleRate(48000); }

    /** Room size preset. Call before setSampleRate (line lengths depend on it). */
    void setRoom(int room){
        room = std::clamp(room, 0, ROOMS - 1);
        static const float SCALE[ROOMS] = {0.55f, 0.8f, 1.0f};
        static const float FB[ROOMS]    = {0.72f, 0.83f, 0.89f};
        static const float DMP[ROOMS]   = {0.40f, 0.28f, 0.20f};
        mScale = SCALE[room];
        mFeedback = FB[room];
        mDamp = DMP[room];
    }

    /** Resizes the lines for [sr] and clears them. Not concurrent with process(). */
    void setSampleRate(int sr){
        if (sr <= 0) return;
        mSr = sr;
        const float s = (float)sr / 44100.f * mScale;
        static const int COMB[8] = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
        static const int AP[4]   = {556, 441, 341, 225};
        for (int c = 0; c < 2; ++c) {
            const int spread = c ? 23 : 0;
            for (int i = 0; i < 8; ++i) mComb[c][i].init((int)((COMB[i] + spread) * s));
            for (int i = 0; i < 4; ++i) mAp[c][i].init((int)((AP[i] + spread) * s));
        }
        mActive = false;
    }
    int sampleRate() const { return mSr; }

    /** In place: [buf] holds the stereo send on input and the wet signal on output. */
    void process(float* buf, int frames){
        float inPeak = 0.f;
        for (int i = 0; i < 2 * frames; ++i) inPeak = std::max(inPeak, std::fabs(buf[i]));
        if (!mActive) {
            if (inPeak < 1e-7f) return;   // buffer already silent
            mActive = true;
            mQuiet = 0;
        }
        float outPeak = 0.f;
        for (int i = 0; i < frames; ++i) {
            const float in = (buf[2 * i] + buf[2 * i + 1]) * FIXED_GAIN;
            float o[2];
            for (int c = 0; c < 2; ++c) {
                float acc = 0.f;
                for (auto& cb : mComb[c]) acc += cb.process(in, mFeedback, mDamp);
                for (auto& ap : mAp[c]) acc = ap.process(acc);
                o[c] = acc;
            }
            buf[2 * i]     = o[0] * WET;
            buf[2 * i + 1] = o[1] * WET;
            outPeak = std::max(outPeak, std::max(std::fabs(o[0]), std::fabs(o[1])));
        }
        if (inPeak < 1e-7f && outPeak < 1e-6f) {
            mQuiet += frames;
            if (mQuiet > mSr / 2) { clear(); mActive = false; }
        } else {
            mQuiet = 0;
        }
    }
    bool isActive() const { return mActive; }

    void clear(){
        for (auto& ch : mComb) for (auto& cb : ch) cb.clear();
        for (auto& ch : mAp)   for (auto& ap : ch) ap.clear();
    }

private:
    static constexpr float FIXED_GAIN = 0.015f;
    static constexpr float WET        = 1.6f;

    struct Comb {
        std::vector<float> b; int i = 0; float store = 0.f;
        void init(int n){ b.assign(std::max(1, n), 0.f); i = 0; store = 0.f; }
        void clear(){ std::fill(b.begin(), b.end(), 0.f); store = 0.f; }
        float process(float in, float feedback, float damp){
            const float out = b[i];
            store = out * (1.f - damp) + store * damp;
            b[i] = in + store * feedback;
            if (++i >= (int)b.size()) i = 0;
            return out;
        }
    };
    struct Allpass {
        std::vector<float> b; int i = 0;
        void init(int n){ b.assign(std::max(1, n), 0.f); i = 0; }
        void clear(){ std::fill(b.begin(), b.end(), 0.f); }
        float process(float in){
            const float bo = b[i];
            b[i] = in + bo * 0.5f;
            if (++i >= (int)b.size()) i = 0;
            return bo - in;
        }
    };

    Comb    mComb[2][8];
    Allpass mAp[2][4];
    int  mSr = 48000;
    float mScale = 0.8f, mFeedback = 0.83f, mDamp = 0.28f;
    bool mActive = false;
    int  mQuiet = 0;
};

} // namespace fx
