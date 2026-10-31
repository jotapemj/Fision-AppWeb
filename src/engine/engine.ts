// Fachada TS del motor WASM (engine/web_api.cpp).
// Un AudioContext y un motor por sesion; cada cancion recrea el motor.

interface EngineModule {
  FS: { mkdir(p: string): void; writeFile(p: string, d: Uint8Array): void; unlink(p: string): void };
  stringToNewUTF8(s: string): number;
  emscriptenRegisterAudioObject(o: AudioContext): number;
  feAudioReady?: (node: number) => void;
  _free(p: number): void;
  _fe_create(sr: number): number;
  _fe_load_clear(): void;
  _fe_load_push(path: number, loop: number, deferred: number): number;
  _fe_load_run(threads: number): number;
  _fe_load_done(): number;
  _fe_load_busy(): number;
  _fe_load_id(i: number): number;
  _fe_load_ms(i: number): number;
  _fe_start(): number;
  _fe_pause(): void;
  _fe_resume(): void;
  _fe_seek_all(ms: number): void;
  _fe_seek_track(id: number, ms: number): void;
  _fe_position_ms(): number;
  _fe_duration_ms(): number;
  _fe_set_tempo(id: number, t: number): void;
  _fe_set_pitch(id: number, semi: number): void;
  _fe_set_volume(id: number, l: number, r: number): void;
  _fe_set_solo_muted(id: number, m: number): void;
  _fe_audio_attach(ctxHandle: number): void;
  _fe_set_filter(id: number, a: number): void;
  _fe_init_hrtf(path: number): number;
  _fe_set_3d_enabled(id: number, on: number): void;
  _fe_set_3d_position(id: number, az: number, dist: number, elevDeg: number): void;
  _fe_set_3d_omni(id: number, on: number): void;
  _fe_set_3d_muted(id: number, on: number): void;
  _fe_set_echo(id: number, a: number, delayMs: number): void;
  _fe_set_reverb(id: number, send: number, room: number): void;
  _fe_envelope(id: number): number;
  _fe_click_wav(path: number): number;
  _fe_click_at(ms: number): void;
  _fe_click_clear(): void;
  _fe_click_enabled(on: number): void;
  _fe_click_duck(id: number): void;
  _fe_envelope_len(): number;
  wasmMemory: WebAssembly.Memory;
}

export interface StemFile { name: string; data: Uint8Array; loop?: boolean }
export interface LoadedStem { name: string; id: number; decodeMs: number }
export interface LoadReport { stems: LoadedStem[]; wallMs: number; threads: number; durationMs: number }

/** Ganancias L/R desde volumen 0..100 y paneo -100..100, como PlaybackService de Android. */
export function stemGains(volume: number, pan: number): [number, number] {
  const v = volume * 0.01;
  if (pan > 0) return [v * (100 - pan) * 0.01, v];
  if (pan < 0) return [v, v * (100 - Math.abs(pan)) * 0.01];
  return [v, v];
}

// import() sin reescribir: Vite le anade ?import y rompe el fichero de public/
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ default: () => Promise<EngineModule> }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  private ids: number[] = [];
  hrtfLoaded = false;
  private hrtf = false; // /hrtf.bin escrito en el FS
  private started = false;

  private M: EngineModule;
  readonly ctx: AudioContext;

  private constructor(M: EngineModule, ctx: AudioContext) { this.M = M; this.ctx = ctx; }

  /** Carga el WASM, crea el AudioContext y el nodo worklet. Llamar tras un gesto del usuario. */
  static async create(latencyHint: AudioContextLatencyCategory = 'playback'): Promise<Engine> {
    if (!crossOriginIsolated) throw new Error('engine_needs_isolation');
    const url = `${import.meta.env.BASE_URL}engine/fision_engine.mjs`;
    const { default: factory } = await nativeImport(url);
    const M: EngineModule = await factory();
    const ctx = new AudioContext({ latencyHint });
    await ctx.suspend(); // sin audio hasta play
    await new Promise<void>((resolve, reject) => {
      M.feAudioReady = (node) => (node ? resolve() : reject(new Error('engine_worklet_failed')));
      M._fe_audio_attach(M.emscriptenRegisterAudioObject(ctx));
    });
    M.FS.mkdir('/s');
    return new Engine(M, ctx);
  }

  /** Recrea el motor y decodifica los stems en paralelo (como addTrack en Android). */
  async load(files: StemFile[], threads = Math.min(navigator.hardwareConcurrency || 4, 8)): Promise<LoadReport> {
    const M = this.M;
    await this.ctx.suspend();
    if (!M._fe_create(this.ctx.sampleRate)) throw new Error('engine_busy');
    // HRTF: una vez en el FS, cargado en cada motor nuevo (sin el, el motor usa ITD/ILD sintetico)
    if (!this.hrtf) {
      const r = await fetch(`${import.meta.env.BASE_URL}hrtf/hrtf_horizontal.bin`).catch(() => null);
      if (r?.ok) { M.FS.writeFile('/hrtf.bin', new Uint8Array(await r.arrayBuffer())); this.hrtf = true; }
    }
    if (this.hrtf) { const p = M.stringToNewUTF8('/hrtf.bin'); this.hrtfLoaded = M._fe_init_hrtf(p) === 1; M._free(p); }
    this.started = false;
    M._fe_load_clear();
    // Las pistas en bucle (metronomos) van al final y esperan al primer stem:
    // la pista 0 es la referencia de posicion y duracion del motor
    files = [...files.filter((f) => !f.loop), ...files.filter((f) => f.loop)];
    const paths = files.map((f, i) => `/s/${i}_${f.name}`);
    files.forEach((f, i) => {
      M.FS.writeFile(paths[i], f.data);
      const p = M.stringToNewUTF8(paths[i]);
      M._fe_load_push(p, f.loop ? 1 : 0, f.loop ? 1 : 0);
      M._free(p);
    });
    const t0 = performance.now();
    const n = M._fe_load_run(threads);
    while (M._fe_load_busy()) await sleep(15);
    const wallMs = performance.now() - t0;
    paths.forEach((p) => M.FS.unlink(p)); // libera el FLAC comprimido
    const stems = files.map((f, i) => ({ name: f.name, id: M._fe_load_id(i), decodeMs: M._fe_load_ms(i) }));
    this.ids = stems.filter((s) => s.id >= 0).map((s) => s.id);
    return { stems, wallMs, threads: n, durationMs: M._fe_duration_ms() };
  }

  async play(): Promise<void> {
    if (!this.started) { this.M._fe_start(); this.started = true; } else this.M._fe_resume();
    await this.ctx.resume();
  }

  pause(): void { this.M._fe_pause(); }
  seek(ms: number): void { this.M._fe_seek_all(ms); }
  seekTrack(id: number, ms: number): void { this.M._fe_seek_track(id, ms); }
  get positionMs(): number { return this.M._fe_position_ms(); }
  get durationMs(): number { return this.M._fe_duration_ms(); }

  /** Tono por pista: la bateria no se transpone (StemSpec.isPitched). */
  setPitch(id: number, semitones: number): void { this.M._fe_set_pitch(id, semitones); }
  /** Tempo a todas las pistas a la vez (sincronia), metronomos incluidos. */
  setTempo(factor: number): void { for (const id of this.ids) this.M._fe_set_tempo(id, factor); }
  setVolume(id: number, volume: number, pan = 0): void { const [l, r] = stemGains(volume, pan); this.M._fe_set_volume(id, l, r); }
  setSoloMuted(id: number, muted: boolean): void { this.M._fe_set_solo_muted(id, muted ? 1 : 0); }
  setFilter(id: number, amount: number): void { this.M._fe_set_filter(id, amount); }
  set3DEnabled(id: number, on: boolean): void { this.M._fe_set_3d_enabled(id, on ? 1 : 0); }
  set3DPosition(id: number, azRad: number, dist: number, elevDeg: number): void { this.M._fe_set_3d_position(id, azRad, dist, elevDeg); }
  set3DOmni(id: number, on: boolean): void { this.M._fe_set_3d_omni(id, on ? 1 : 0); }
  set3DMuted(id: number, on: boolean): void { this.M._fe_set_3d_muted(id, on ? 1 : 0); }
  setEcho(id: number, amount: number, delayMs: number): void { this.M._fe_set_echo(id, amount, delayMs); }
  setReverb(id: number, send: number, room: number): void { this.M._fe_set_reverb(id, send, room); }
  /** Click de downbeat: carga el WAV en el motor (empieza mudo; vacia la cola). Repetir tras cada load. */
  setClickWav(data: Uint8Array): boolean {
    const M = this.M;
    M.FS.writeFile('/click.wav', data);
    const p = M.stringToNewUTF8('/click.wav');
    const ok = M._fe_click_wav(p) === 1;
    M._free(p); M.FS.unlink('/click.wav');
    return ok;
  }
  clickAt(ms: number): void { this.M._fe_click_at(ms); }
  clearClicks(): void { this.M._fe_click_clear(); }
  setClickEnabled(on: boolean): void { this.M._fe_click_enabled(on ? 1 : 0); }
  /** Pista que se atenua 160 ms al sonar el click (el metronomo activo; -1 = ninguna). */
  setClickDuck(id: number): void { this.M._fe_click_duck(id); }
  /** Envolvente RMS (dBFS cada 10 ms) de la pista, calculada al cargar (Track::computeEnvelope). */
  envelope(id: number): Float32Array {
    const p = this.M._fe_envelope(id), n = this.M._fe_envelope_len();
    return n ? new Float32Array(this.M.wasmMemory.buffer, p, n).slice() : new Float32Array(0);
  }
}
