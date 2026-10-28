#include "HrtfBank.h"
#include <android/log.h>
#include <cstring>
#include <cmath>
#include <algorithm>

#define TAG "HrtfBank"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)

static constexpr uint32_t MAGIC_1 = 0x31524846u; // "FHR1" legacy
static constexpr uint32_t MAGIC_2 = 0x32524846u; // "FHR2" with elevation
static constexpr float PI_F     = 3.14159265358979323846f;

bool HrtfBank::loadFromAssets(AAssetManager* mgr, const char* assetPath) {
    if (!mgr || !assetPath) return false;
    AAsset* a = AAssetManager_open(mgr, assetPath, AASSET_MODE_BUFFER);
    if (!a) { LOGE("open failed: %s", assetPath); return false; }

    uint32_t magic = 0;
    if (AAsset_read(a, &magic, sizeof(uint32_t)) != sizeof(uint32_t)) {
        AAsset_close(a); LOGE("short header"); return false;
    }

    if (magic == MAGIC_1) {
        // Legacy: no elevation
        uint32_t numAz = 0, len = 0;
        float sr = 0.f;
        AAsset_read(a, &numAz, sizeof(uint32_t));
        AAsset_read(a, &len,   sizeof(uint32_t));
        AAsset_read(a, &sr,    sizeof(float));
        if ((int)numAz <= 0 || (int)len <= 0 || numAz > 4096 || len > 8192) {
            AAsset_close(a); LOGE("FHR1 bad hdr numAz=%u len=%u", numAz, len); return false;
        }
        size_t need = (size_t) numAz * 2 * (size_t) len * sizeof(float);
        std::vector<float> buf(need / sizeof(float));
        int got = AAsset_read(a, buf.data(), need);
        AAsset_close(a);
        if ((size_t) got != need) { LOGE("FHR1 short read"); return false; }
        mNumAzimuths    = (int) numAz;
        mNumElevations  = 1;
        mHrirLength     = (int) len;
        mDataSR         = sr;
        mElevations     = { 0.f };
        mData           = std::move(buf);
        mLoaded.store(true, std::memory_order_release);
        LOGI("HRTF FHR1 ok: numAz=%d len=%d sr=%.0f", mNumAzimuths, mHrirLength, sr);
        return true;
    }

    if (magic == MAGIC_2) {
        uint32_t numElev = 0, numAz = 0, len = 0;
        float sr = 0.f;
        AAsset_read(a, &numElev, sizeof(uint32_t));
        AAsset_read(a, &numAz,   sizeof(uint32_t));
        AAsset_read(a, &len,     sizeof(uint32_t));
        AAsset_read(a, &sr,      sizeof(float));
        if (numElev == 0 || numAz == 0 || len == 0
            || numElev > 128 || numAz > 4096 || len > 8192) {
            AAsset_close(a); LOGE("FHR2 bad hdr elev=%u az=%u len=%u", numElev, numAz, len); return false;
        }
        std::vector<float> elevs(numElev);
        AAsset_read(a, elevs.data(), numElev * sizeof(float));

        size_t need = (size_t) numElev * numAz * 2 * len * sizeof(float);
        std::vector<float> buf(need / sizeof(float));
        int got = AAsset_read(a, buf.data(), need);
        AAsset_close(a);
        if ((size_t) got != need) { LOGE("FHR2 short read"); return false; }
        mNumAzimuths   = (int) numAz;
        mNumElevations = (int) numElev;
        mHrirLength    = (int) len;
        mDataSR        = sr;
        mElevations    = std::move(elevs);
        mData          = std::move(buf);
        mLoaded.store(true, std::memory_order_release);
        LOGI("HRTF FHR2 ok: elev=%d az=%d len=%d sr=%.0f",
             mNumElevations, mNumAzimuths, mHrirLength, sr);
        return true;
    }

    AAsset_close(a);
    LOGE("bad magic 0x%X", magic);
    return false;
}

void HrtfBank::findElevNeighbors(float elevDeg, int& i0, int& i1, float& frac) const {
    if (mNumElevations <= 1) { i0 = i1 = 0; frac = 0.f; return; }
    if (elevDeg <= mElevations.front()) { i0 = i1 = 0; frac = 0.f; return; }
    if (elevDeg >= mElevations.back())  { i0 = i1 = mNumElevations - 1; frac = 0.f; return; }
    // binary search of the segment
    auto it = std::lower_bound(mElevations.begin(), mElevations.end(), elevDeg);
    i1 = (int) (it - mElevations.begin());
    i0 = i1 - 1;
    float span = mElevations[i1] - mElevations[i0];
    frac = span > 0.f ? (elevDeg - mElevations[i0]) / span : 0.f;
}

bool HrtfBank::sampleInterpolated(float azimuthRad, float elevationDeg,
                                  float* outL, float* outR) const {
    if (!mLoaded.load(std::memory_order_acquire)) return false;

    // Azimuth to [0, 2π)
    float az = azimuthRad;
    while (az < 0.f)         az += 2.f * PI_F;
    while (az >= 2.f * PI_F) az -= 2.f * PI_F;
    float step = 2.f * PI_F / (float) mNumAzimuths;
    float azIdxf = az / step;
    int   j0 = (int) std::floor(azIdxf) % mNumAzimuths;
    int   j1 = (j0 + 1) % mNumAzimuths;
    float fA = azIdxf - std::floor(azIdxf);

    // Elevation → 2 neighbors
    int i0, i1;
    float fE;
    findElevNeighbors(elevationDeg, i0, i1, fE);

    size_t azStride   = (size_t) 2 * mHrirLength;
    size_t elevStride = (size_t) mNumAzimuths * azStride;

    const float* p00L = mData.data() + i0 * elevStride + j0 * azStride;
    const float* p00R = p00L + mHrirLength;
    const float* p01L = mData.data() + i0 * elevStride + j1 * azStride;
    const float* p01R = p01L + mHrirLength;
    const float* p10L = mData.data() + i1 * elevStride + j0 * azStride;
    const float* p10R = p10L + mHrirLength;
    const float* p11L = mData.data() + i1 * elevStride + j1 * azStride;
    const float* p11R = p11L + mHrirLength;

    float w00 = (1.f - fE) * (1.f - fA);
    float w01 = (1.f - fE) *        fA;
    float w10 =        fE  * (1.f - fA);
    float w11 =        fE  *        fA;

    for (int i = 0; i < mHrirLength; ++i) {
        outL[i] = p00L[i] * w00 + p01L[i] * w01 + p10L[i] * w10 + p11L[i] * w11;
        outR[i] = p00R[i] * w00 + p01R[i] * w01 + p10R[i] * w10 + p11R[i] * w11;
    }
    return true;
}
