#pragma once
#include <vector>
#include <atomic>
#include <cstdint>
#include <android/asset_manager.h>

/**
 * HRIR bank (Head-Related Impulse Responses) 2D (elevation × azimuth).
 *
 * Binary format of `assets/hrtf/hrtf_horizontal.bin`:
 *
 *   FHR1 (legacy, horizontal plane only):
 *     uint32  magic         = 0x31524846 ("FHR1")
 *     uint32  numAzimuths
 *     uint32  hrirLength
 *     float32 sampleRate
 *     float32 data[numAz][2][hrirLength]  // [az][L, R][sample]
 *
 *   FHR2 (with elevation):
 *     uint32  magic         = 0x32524846 ("FHR2")
 *     uint32  numElevations
 *     uint32  numAzimuths
 *     uint32  hrirLength
 *     float32 sampleRate
 *     float32 elevations[numElevations]              // degrees
 *     float32 data[numElev][numAz][2][hrirLength]    // [elev][az][L, R][sample]
 *
 * Azimuths are uniform on [0, 360). Elevations are NOT necessarily uniform:
 * they are stored explicitly and the interpolation looks up the 2 neighbors
 * per segment. L = left ear, R = right ear.
 */
class HrtfBank {
public:
    HrtfBank() = default;

    /** Returns true when loaded successfully. */
    bool loadFromAssets(AAssetManager* mgr, const char* assetPath);

    bool     isLoaded()      const { return mLoaded.load(std::memory_order_acquire); }
    int      hrirLength()    const { return mHrirLength; }
    int      numAzimuths()   const { return mNumAzimuths; }
    int      numElevations() const { return mNumElevations; }
    float    dataSampleRate()const { return mDataSR; }

    /** Fills outL/outR (size hrirLength) with HRIRs linearly interpolated
     *  between the 4 neighbors (2 azimuths × 2 elevations). azimuthRad in [-π, π];
     *  elevationDeg in degrees (typically [-40, 90]). Returns false when !isLoaded. */
    bool sampleInterpolated(float azimuthRad, float elevationDeg,
                            float* outL, float* outR) const;

private:
    std::atomic<bool> mLoaded{false};
    int mNumAzimuths    = 0;
    int mNumElevations  = 1;
    int mHrirLength     = 0;
    float mDataSR       = 44100.f;
    std::vector<float> mElevations;   // degrees; ascending order
    // Flat layout: [elev][az][L/R][sample]
    // stride per elev = 2 * numAz * hrirLen
    // stride per az   = 2 * hrirLen
    std::vector<float> mData;

    // Finds the 2 neighbor indices in mElevations + interpolation fraction.
    void findElevNeighbors(float elevDeg, int& i0, int& i1, float& frac) const;
};
