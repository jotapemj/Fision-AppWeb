#pragma once
#include <atomic>
#include <cstdint>
#include <vector>
#include <algorithm>

// Lock-free SPSC ring buffer indexed by INTERLEAVED FRAMES (float).
// Size in frames must be a power of two so the mask works.
class RingBuffer {
public:
    RingBuffer() = default;
    void init(uint32_t frames, uint32_t channels){
        mChannels = channels;
        mMask = nextPow2(frames) - 1u;
        mBuf.resize((mMask + 1u) * channels);
        mRead.store(0, std::memory_order_relaxed);
        mWrite.store(0, std::memory_order_relaxed);
    }
    uint32_t capacityFrames() const { return mMask + 1u; }
    uint32_t sizeFrames() const {
        uint32_t r = mRead.load(std::memory_order_acquire);
        uint32_t w = mWrite.load(std::memory_order_acquire);
        return (w - r) & mMask;
    }
    uint32_t freeFrames() const { return capacityFrames() - sizeFrames(); }

    // push: writes up to nFrames from src (interleaved). Returns frames written
    uint32_t push(const float* src, uint32_t nFrames){
        uint32_t w = mWrite.load(std::memory_order_relaxed);
        uint32_t free = freeFrames();
        uint32_t todo = std::min(nFrames, free);
        for(uint32_t f=0; f<todo; ++f){
            uint32_t idx = ((w + f) & mMask) * mChannels;
            std::copy_n(src + f*mChannels, mChannels, mBuf.data() + idx);
        }
        mWrite.store(w + todo, std::memory_order_release);
        return todo;
    }

    // popAdd: reads up to nFrames and sums them into dst (interleaved). Returns frames read
    uint32_t popAdd(float* dst, uint32_t nFrames){
        uint32_t r = mRead.load(std::memory_order_relaxed);
        uint32_t avail = sizeFrames();
        uint32_t todo = std::min(nFrames, avail);
        for(uint32_t f=0; f<todo; ++f){
            uint32_t idx = ((r + f) & mMask) * mChannels;
            for(uint32_t c=0; c<mChannels; ++c){
                dst[f*mChannels + c] += mBuf[idx + c];
            }
        }
        mRead.store(r + todo, std::memory_order_release);
        return todo;
    }

    void clear(){ mRead.store(0); mWrite.store(0); }

private:
    static uint32_t nextPow2(uint32_t v){
        v--; v |= v>>1; v |= v>>2; v|=v>>4; v|=v>>8; v|=v>>16; v++; return v?v:1;
    }
    std::vector<float> mBuf;
    uint32_t mChannels = 2;
    uint32_t mMask = 0;
    std::atomic<uint32_t> mRead{0}, mWrite{0};
};
