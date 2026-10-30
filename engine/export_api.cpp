// Export offline (modulo aparte, sin hilos, para un Worker): decodificar stems y pasar
// un stem por sus FX como StemFxOffline de Android (AudioEngine_JNI.cpp, OfflineFx).
// La mezcla, el limitador y la escritura van en JS (src/export/).
#include <emscripten/emscripten.h>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <cstring>
#include <vector>
#include "StemFx.h"
#include "WavReader.h"
#define DR_FLAC_IMPLEMENTATION
#include "dr_flac.h"

namespace {
constexpr int CHUNK = 4096; // como StemFxOffline.CHUNK

// PCM decodificado del ultimo fx_decode (intercalado)
std::vector<float> gPcm;
int gSr = 0, gCh = 0;

// Entrada / salida de un trozo de fx_process (estereo intercalado)
float gSrc[CHUNK * 2];
float gOut[CHUNK * 2];

struct OfflineFx {
    int sr;
    fx::Filter filter;
    fx::Echo   echo;
    fx::Reverb reverb;
    float send = 0.f;
    std::vector<float> wet;
    OfflineFx(int s, int room) : sr(s) { reverb.setRoom(room); reverb.setSampleRate(s); }
};

bool endsWith(const char* s, const char* suf) {
    size_t a = std::strlen(s), b = std::strlen(suf);
    if (a < b) return false;
    for (size_t i = 0; i < b; ++i) if (std::tolower(s[a - b + i]) != suf[i]) return false;
    return true;
}
}

extern "C" {

// Decodifica FLAC o WAV (PCM16 / float32) del FS. Devuelve frames (0 = fallo).
EMSCRIPTEN_KEEPALIVE int fx_decode(const char* path) {
    gPcm.clear(); gPcm.shrink_to_fit(); gSr = gCh = 0;
    if (endsWith(path, ".flac")) {
        unsigned int ch = 0, sr = 0;
        drflac_uint64 frames = 0;
        float* s = drflac_open_file_and_read_pcm_frames_f32(path, &ch, &sr, &frames, nullptr);
        if (!s) return 0;
        if ((ch == 1 || ch == 2) && frames > 0) { gPcm.assign(s, s + (size_t)frames * ch); gSr = (int)sr; gCh = (int)ch; }
        drflac_free(s, nullptr);
    } else {
        WavData d;
        if (!loadWavPcmToFloat(path, d) || (d.channels != 1 && d.channels != 2)) return 0;
        gPcm = std::move(d.pcm); gSr = d.sampleRate; gCh = d.channels;
    }
    return gCh ? (int)(gPcm.size() / gCh) : 0;
}
EMSCRIPTEN_KEEPALIVE float* fx_pcm() { return gPcm.data(); }
EMSCRIPTEN_KEEPALIVE int fx_pcm_sr() { return gSr; }
EMSCRIPTEN_KEEPALIVE int fx_pcm_ch() { return gCh; }
EMSCRIPTEN_KEEPALIVE void fx_pcm_free() { gPcm.clear(); gPcm.shrink_to_fit(); }

EMSCRIPTEN_KEEPALIVE float* fx_src() { return gSrc; }
EMSCRIPTEN_KEEPALIVE float* fx_out() { return gOut; }

// = nativeCreate
EMSCRIPTEN_KEEPALIVE OfflineFx* fx_new(int sr, float filter, float echo, float echoDelayMs, float send, int room) {
    auto* o = new OfflineFx(sr, room);
    o->filter.setAmount(filter);
    if (echo > 0.f) o->echo.prepare(sr);
    o->echo.setDelaySourceMs(echoDelayMs);
    o->echo.setAmount(echo);
    o->send = std::max(0.f, std::min(1.f, send));
    return o;
}
EMSCRIPTEN_KEEPALIVE void fx_free(OfflineFx* o) { delete o; }

// = nativeProcess, pero sin sumar: gSrc (estereo, o nada = cola en silencio) -> gOut con
// filtro, eco, volumen y la reverb del envio. JS suma gOut a la mezcla.
EMSCRIPTEN_KEEPALIVE void fx_process(OfflineFx* o, int hasSrc, int frames, float volL, float volR) {
    if (!o || frames <= 0 || frames > CHUNK) return;
    float* c = gOut;
    if (hasSrc) std::memcpy(c, gSrc, sizeof(float) * frames * 2);
    else std::memset(c, 0, sizeof(float) * frames * 2);
    if (o->filter.isActive()) o->filter.process(c, frames, o->sr);
    if (o->echo.isActive())   o->echo.process(c, frames, o->sr, 1.f);
    for (int f = 0; f < frames; ++f) { c[2 * f] *= volL; c[2 * f + 1] *= volR; }
    if (o->send > 0.f) {
        o->wet.resize((size_t)frames * 2);
        for (int i = 0; i < frames * 2; ++i) o->wet[i] = c[i] * o->send;
        o->reverb.process(o->wet.data(), frames);
        for (int i = 0; i < frames * 2; ++i) c[i] += o->wet[i];
    }
}

}
