// API C plana sobre AudioEngine para JS.
// Web: Wasm Audio Worklet llama a onAudioReady (papel del hilo de Oboe).
// Node (tests): sin worklet; fe_render() renderiza offline.
#include <emscripten/emscripten.h>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>
#include "AudioEngine.h"
#ifdef FE_AUDIO_WORKLET
#include <emscripten/webaudio.h>
#endif

int32_t oboe::gShimSampleRate = 48000;

namespace {
AudioEngine* gEngine = nullptr;
oboe::AudioStream gStream;        // solo para getXRunCount() en onAudioReady
std::vector<float> gOut;          // salida intercalada de fe_render
std::atomic<bool> gRunning{false}; // como Oboe: sin callback hasta start()
std::atomic<bool> gInRender{false}; // hilo de audio dentro de onAudioReady

// Carga en paralelo: varios hilos llaman a addTrack, como Java en Android
struct LoadJob {
    std::vector<std::string> paths;
    std::vector<char> loop;      // metronomos: en bucle (como Android)
    std::vector<char> deferred;  // esperan al primer stem: la pista 0 (referencia de posicion) es musica
    std::vector<int> ids;
    std::vector<double> ms;
    std::atomic<int> next{0};
    std::atomic<int> done{0};
    std::atomic<int> workers{0};
} gLoad;

void loadWorker() {
    for (;;) {
        int i = gLoad.next.fetch_add(1);
        if (i >= (int)gLoad.paths.size()) break;
        if (gLoad.deferred[i]) while (gLoad.done.load() == 0) std::this_thread::sleep_for(std::chrono::milliseconds(2));
        double t0 = emscripten_get_now();
        gLoad.ids[i] = gEngine->addTrack(gLoad.paths[i].c_str(), gLoad.loop[i] != 0);
        gLoad.ms[i] = emscripten_get_now() - t0;
        gLoad.done.fetch_add(1);
    }
    gLoad.workers.fetch_sub(1);
}
}

extern "C" {

// Crea (o recrea, al cambiar de cancion) el motor
EMSCRIPTEN_KEEPALIVE int fe_create(int sampleRate) {
    if (gLoad.workers.load() > 0) return 0; // carga en curso
    gRunning.store(false);
    while (gInRender.load()) {} // esperar a que el hilo de audio suelte el motor
    delete gEngine;
    oboe::gShimSampleRate = sampleRate;
    gEngine = new AudioEngine();
    return 1;
}

// === Carga ===
EMSCRIPTEN_KEEPALIVE void fe_load_clear() {
    gLoad.paths.clear(); gLoad.loop.clear(); gLoad.deferred.clear(); gLoad.ids.clear(); gLoad.ms.clear();
    gLoad.next = 0; gLoad.done = 0;
}
// Los diferidos van al final de la lista (si no, un hilo podria esperar sin stems pendientes)
EMSCRIPTEN_KEEPALIVE int fe_load_push(const char* path, int loop, int deferred) {
    gLoad.paths.emplace_back(path);
    gLoad.loop.push_back(loop != 0); gLoad.deferred.push_back(deferred != 0);
    gLoad.ids.push_back(-1); gLoad.ms.push_back(0);
    return (int)gLoad.paths.size() - 1;
}
// Lanza `threads` hilos y vuelve al momento; JS consulta fe_load_done()
EMSCRIPTEN_KEEPALIVE int fe_load_run(int threads) {
    if (gLoad.workers.load() > 0) return 0;
    // Sin stems normales nadie desbloquearia a los diferidos
    bool anyNormal = false;
    for (char d : gLoad.deferred) anyNormal |= !d;
    if (!anyNormal) std::fill(gLoad.deferred.begin(), gLoad.deferred.end(), 0);
    int n = std::max(1, std::min(threads, (int)gLoad.paths.size()));
    gLoad.workers = n;
    for (int k = 0; k < n; ++k) std::thread(loadWorker).detach();
    return n;
}
EMSCRIPTEN_KEEPALIVE int fe_load_done() { return gLoad.done.load(); }
EMSCRIPTEN_KEEPALIVE int fe_load_busy() { return gLoad.workers.load() > 0; }
EMSCRIPTEN_KEEPALIVE int fe_load_id(int i) { return gLoad.ids[i]; }
EMSCRIPTEN_KEEPALIVE double fe_load_ms(int i) { return gLoad.ms[i]; }

// === Transporte ===
EMSCRIPTEN_KEEPALIVE int fe_start() { bool ok = gEngine->start(); gRunning.store(ok); return ok; }
EMSCRIPTEN_KEEPALIVE void fe_pause() { gEngine->pause(); }
EMSCRIPTEN_KEEPALIVE void fe_resume() { gEngine->resume(); }
EMSCRIPTEN_KEEPALIVE void fe_seek_all(double ms) { gEngine->seekToAll((int64_t)ms); }
EMSCRIPTEN_KEEPALIVE void fe_seek_track(int id, double ms) { gEngine->seekToMs(id, (int64_t)ms); }
EMSCRIPTEN_KEEPALIVE double fe_position_ms() { return (double)gEngine->getCurrentPositionAllMs(); }
EMSCRIPTEN_KEEPALIVE double fe_duration_ms() { return (double)gEngine->getDurationMs(); }

// === Por pista ===
EMSCRIPTEN_KEEPALIVE void fe_set_tempo(int id, float t) { gEngine->setTempo(id, t); }
EMSCRIPTEN_KEEPALIVE void fe_set_pitch(int id, float semi) { gEngine->setPitch(id, semi); }
EMSCRIPTEN_KEEPALIVE void fe_set_volume(int id, float l, float r) { gEngine->setVolume(id, l, r); }
EMSCRIPTEN_KEEPALIVE void fe_set_solo_muted(int id, int m) { gEngine->setTrackSoloMuted(id, m != 0); }

// Render offline (tests): `frames` frames estereo intercalados
EMSCRIPTEN_KEEPALIVE float* fe_render(int frames) {
    gOut.resize((size_t)frames * 2);
    gEngine->onAudioReady(&gStream, gOut.data(), frames);
    return gOut.data();
}

#ifdef FE_AUDIO_WORKLET
namespace {
constexpr int kMaxQuantum = 4096;
float gAudioBuf[kMaxQuantum * 2]; // solo hilo de audio
alignas(16) uint8_t gAudioStack[256 * 1024];

bool process(int, const AudioSampleFrame*, int numOutputs, AudioSampleFrame* outputs,
             int, const AudioParamFrame*, void*) {
    if (numOutputs < 1) return true;
    AudioSampleFrame& o = outputs[0];
    const int n = std::min(o.samplesPerChannel, kMaxQuantum);
    float* L = o.data;
    float* R = o.numberOfChannels > 1 ? o.data + n : nullptr;
    // Marcar antes de mirar gRunning: fe_create espera a gInRender=false
    gInRender.store(true);
    if (!gRunning.load()) {
        gInRender.store(false);
        std::fill(o.data, o.data + n * o.numberOfChannels, 0.f);
        return true;
    }
    gEngine->onAudioReady(&gStream, gAudioBuf, n);
    gInRender.store(false);
    for (int i = 0; i < n; ++i) {
        L[i] = gAudioBuf[2 * i];
        if (R) R[i] = gAudioBuf[2 * i + 1];
    }
    return true;
}

void onProcessorCreated(EMSCRIPTEN_WEBAUDIO_T ctx, bool ok, void*) {
    if (!ok) { EM_ASM(Module.feAudioReady?.(0)); return; }
    int outCh[1] = {2};
    EmscriptenAudioWorkletNodeCreateOptions opts = {};
    opts.numberOfInputs = 0;
    opts.numberOfOutputs = 1;
    opts.outputChannelCounts = outCh;
    EMSCRIPTEN_WEBAUDIO_T node =
        emscripten_create_wasm_audio_worklet_node(ctx, "fision", &opts, &process, nullptr);
    emscripten_audio_node_connect(node, ctx, 0, 0);
    EM_ASM(Module.feAudioReady?.($0), node);
}

void onThreadStarted(EMSCRIPTEN_WEBAUDIO_T ctx, bool ok, void*) {
    if (!ok) { EM_ASM(Module.feAudioReady?.(0)); return; }
    WebAudioWorkletProcessorCreateOptions opts = {};
    opts.name = "fision";
    emscripten_create_wasm_audio_worklet_processor_async(ctx, &opts, &onProcessorCreated, nullptr);
}
}

// ctx = handle de emscriptenRegisterAudioObject(AudioContext). Avisa en Module.feAudioReady(node)
EMSCRIPTEN_KEEPALIVE void fe_audio_attach(EMSCRIPTEN_WEBAUDIO_T ctx) {
    emscripten_start_wasm_audio_worklet_thread_async(ctx, gAudioStack, sizeof(gAudioStack),
                                                     &onThreadStarted, nullptr);
}
#endif

} // extern "C"
