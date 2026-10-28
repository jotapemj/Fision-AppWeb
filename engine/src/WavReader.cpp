#include "WavReader.h"
#include <cstdio>
#include <cstdint>
#include <vector>
#include <cstring>
#include <android/log.h>

#define TAG "WavReader"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

#pragma pack(push,1)
struct RiffHeader { char riff[4]; uint32_t size; char wave[4]; };
struct ChunkHeader{ char id[4]; uint32_t size; };
struct FmtPcm16 { uint16_t format; uint16_t channels; uint32_t sampleRate; uint32_t byteRate; uint16_t blockAlign; uint16_t bitsPerSample; };
#pragma pack(pop)

static bool readExact(FILE* f, void* dst, size_t n){ return fread(dst,1,n,f)==n; }
static bool idEq(const char id[4], const char* s){ return std::memcmp(id,s,4)==0; }

bool loadWavPcmToFloat(const char* path, WavData& out){
    out = {}; // reset
    FILE* f = std::fopen(path, "rb");
    if(!f){ LOGE("Could not open %s", path); return false; }

    RiffHeader rh{}; if(!readExact(f,&rh,sizeof(rh))){ std::fclose(f); return false; }
    if(!idEq(rh.riff,"RIFF") || !idEq(rh.wave,"WAVE")){ LOGE("Not RIFF/WAVE: %s", path); std::fclose(f); return false; }

    uint16_t fmtFormat = 0, fmtCh=0, fmtBps=0; uint32_t fmtSR=0; uint32_t dataSize=0; long dataPos=0;

    // walk chunks until 'fmt ' and 'data' are found
    while(true){
        ChunkHeader ch{}; if(!readExact(f,&ch,sizeof(ch))) break;
        if(idEq(ch.id,"fmt ")){
            if(ch.size < sizeof(FmtPcm16)){ LOGE("fmt chunk too small"); std::fclose(f); return false; }
            FmtPcm16 fmt{}; if(!readExact(f,&fmt,sizeof(fmt))){ std::fclose(f); return false; }
            // skip any extra bytes in the fmt chunk
            if(ch.size > sizeof(fmt)) std::fseek(f, ch.size - sizeof(fmt), SEEK_CUR);
            fmtFormat = fmt.format; fmtCh = fmt.channels; fmtSR = fmt.sampleRate; fmtBps = fmt.bitsPerSample;
        } else if(idEq(ch.id,"data")){
            dataSize = ch.size; dataPos = std::ftell(f); std::fseek(f, ch.size, SEEK_CUR);
        } else {
            // ignore other chunks
            std::fseek(f, ch.size, SEEK_CUR);
        }
        // chunks are aligned to 2 bytes
        if((ch.size & 1) != 0) std::fseek(f, 1, SEEK_CUR);
    }

    if(fmtFormat==0 || dataPos==0){ LOGE("Missing fmt or data in %s", path); std::fclose(f); return false; }
    if(!(fmtFormat==1 || fmtFormat==3)){ LOGE("Unsupported WAV format (fmt=%d)", fmtFormat); std::fclose(f); return false; }
    if(!(fmtCh==1 || fmtCh==2)){ LOGE("Unsupported channel count: %d", fmtCh); std::fclose(f); return false; }
    if(!(fmtBps==16 || (fmtFormat==3 && fmtBps==32))){ LOGE("Unsupported bits per sample: %d", fmtBps); std::fclose(f); return false; }

    // read data
    std::vector<uint8_t> raw(dataSize);
    std::fseek(f, dataPos, SEEK_SET);
    if(!readExact(f, raw.data(), raw.size())){ std::fclose(f); return false; }
    std::fclose(f);

    // convert to interleaved float [-1,1]
    const size_t bytesPerSample = fmtBps/8;
    const size_t frames = dataSize / (bytesPerSample * fmtCh);
    out.sampleRate = (int)fmtSR;
    out.channels   = (int)fmtCh;
    out.pcm.resize(frames * fmtCh);

    if(fmtFormat==1 && fmtBps==16){
        const int16_t* p = reinterpret_cast<const int16_t*>(raw.data());
        for(size_t i=0;i<frames*fmtCh;++i){ out.pcm[i] = (float)p[i] / 32768.0f; }
    } else if(fmtFormat==3 && fmtBps==32){
        const float* p = reinterpret_cast<const float*>(raw.data());
        std::memcpy(out.pcm.data(), p, frames*fmtCh*sizeof(float));
    }

    LOGI("WAV ok: %s  SR=%u ch=%u frames=%zu bps=%u", path, fmtSR, fmtCh, frames, fmtBps);
    return true;
}
