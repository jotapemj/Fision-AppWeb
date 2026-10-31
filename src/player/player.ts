// Estado y reglas del reproductor (sin DOM). Reglas de app_spec §3.
import type { Engine, LoadedStem } from '../engine/engine.ts';
import { DEFAULT_VOLUME, isMetronome, isPitched, METRONOMES, orderIndex, stemOf } from './stems.ts';
import { defaultPose, elevRad, flatDist, flatElevDeg, sphericalDist, type Pose3D } from './audio3d.ts';

// repeat_mode de Android
const SEEK_LAND_MS = 250;  // el motor ya esta en el destino
const SEEK_WAIT_MS = 1000; // sonando, nunca se espera mas
export const Repeat = { Off: 0, All: 1, One: 2 } as const;
export type Repeat = (typeof Repeat)[keyof typeof Repeat];

/** FX de un stem (StemFx.java): solo en memoria. */
export interface StemFx { filter: number; echo: number; echoDivision: number; reverb: number; room: number }
export const ECHO_BEATS = [2, 1, 0.75, 0.5, 1 / 3, 0.25];
export const ECHO_LABELS = ['1/2', '1/4', '1/8·', '1/8', '1/3', '1/16'];
export const FX_FALLBACK_BPM = 120;
export const FILTER_DEAD_ZONE = 3; // en la escala -100..100
export const newFx = (): StemFx => ({ filter: 0, echo: 0, echoDivision: 2, reverb: 0, room: 1 });
export const fxActive = (f: StemFx) => f.filter !== 0 || f.echo > 0 || f.reverb > 0;
/** Corte del filtro (Hz): paso alto 20*750^a, paso bajo 20000*0.01^a. */
export const filterCutoffHz = (a: number) => (a > 0 ? 20 * Math.pow(750, a) : 20000 * Math.pow(0.01, Math.abs(a)));
/** Retardo del eco en ms de la fuente (tempo original). */
export const echoDelayMs = (bpm: number | null, division: number) => 60000 / (bpm && bpm > 0 ? bpm : FX_FALLBACK_BPM) * ECHO_BEATS[Math.max(0, Math.min(ECHO_BEATS.length - 1, division))];

export interface StemState {
  stem: string;
  id: number;
  volume: number;     // 0..100 (mute = 0)
  lastVolume: number; // para quitar mute
  pan: number;        // -100..100
  solo: boolean;      // no se guarda
  fx: StemFx;         // no se guarda
}

/** Lo que el motor necesita de una cancion abierta. */
export interface SongData { stems: LoadedStem[]; durationMs: number; bpm: number | null; beats?: number[] }

/** Metronomo elegido: 0 = 0.5x, 1 = 1x, 2 = 2x (selectedMetronome de Android). */
export type MetroSpeed = 0 | 1 | 2;
const METRO_STEM = [METRONOMES.half, METRONOMES.one, METRONOMES.double] as const;

export type EndResult = 'looped' | 'next' | 'stopped';

/** BPM global = primera linea de beats.txt. */
export function parseBpm(beatsTxt: string | null): number | null {
  const v = beatsTxt ? parseFloat(beatsTxt.split(/\r?\n/, 1)[0]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Beats (s) = lineas 2.. de beats.txt. */
export function parseBeats(beatsTxt: string | null): number[] {
  if (!beatsTxt) return [];
  return beatsTxt.split(/\r?\n/).slice(1).map(parseFloat).filter((v) => Number.isFinite(v));
}

/** Intervalo entre los dos beats que rodean `posMs` (PlayerActivity.localBeatIntervalMs). */
export function localBeatIntervalMs(beats: number[], posMs: number, bpm: number | null): number {
  if (beats.length < 2) return bpm ? Math.trunc(60000 / bpm) : 500;
  const sec = posMs / 1000;
  let i = 0;
  while (i + 1 < beats.length && beats[i + 1] <= sec) i++;
  if (i + 1 >= beats.length) i = beats.length - 2;
  // Aritmetica float de 32 bits, como Java: 2.8f - 2.1f da 700 ms, en double 699
  const f = Math.fround;
  let iv = f(f(beats[i + 1]) - f(beats[i]));
  if (iv <= 0) iv = 0.5;
  return Math.trunc(f(iv * 1000));
}

export const PITCH_MIN = -12, PITCH_MAX = 12;
export const BPM_MIN = 50, BPM_MAX = 200;
export const MULT_MIN = 0.5, MULT_MAX = 1.5, MULT_STEP = 0.05; // sin BPM
const BEAT_SYNC_OFFSET_MS = 130; // PlaybackService: posicion percibida

export class Player {
  readonly stems: StemState[];
  readonly metronomeIds: Record<string, number> = {};
  readonly durationMs: number;
  readonly bpm: number | null;
  readonly beats: number[];
  // Metronomo (§3.4): defaults de Room
  metroOn = false;
  metroSpeed: MetroSpeed = 1;
  metroVolume = 100;
  metroHalfB = false; // variante B del 0.5x: desfase de un beat local
  chordsBasic = false; // chords_basic.txt en vez de chords.txt (por cancion)
  chordsOnLyrics = false; // nombres de acorde sobre la letra (por cancion)
  pitch = 0;
  tempoMult = 1;
  repeat: Repeat = Repeat.Off;
  // Audio 3D (§3.7): en 3D no cuentan volumen ni balance
  audio3d = false;
  /** Vista plana 2D (audio3d_scene_enabled off): el motor recibe otra distancia. */
  flat3d = false;
  readonly poses = new Map<string, Pose3D>();
  autoplayNext = false;
  playing = false;
  // Click de downbeat (global): solo suena con el metronomo encendido (PlayerActivity)
  downbeatOn = false;
  private clickLoaded = false;
  private downbeats: number[] = []; // ms de las celdas con isDownbeat
  private repeatOneUsed = false;
  /** Algo guardable cambio (mezcla, tono, tempo, metronomo). El solo no cuenta. */
  onChange: (() => void) | null = null;
  private engine: Engine;

  constructor(engine: Engine, song: SongData) {
    this.engine = engine;
    this.durationMs = song.durationMs;
    this.bpm = song.bpm;
    this.beats = song.beats ?? [];
    const st: StemState[] = [];
    for (const s of song.stems) {
      if (s.id < 0) continue;
      const stem = stemOf(s.name);
      if (isMetronome(stem)) {
        // Metronomos: cargados y mudos hasta elegir uno (§3.4)
        this.metronomeIds[stem] = s.id;
        engine.setVolume(s.id, 0);
        continue;
      }
      st.push({ stem, id: s.id, volume: DEFAULT_VOLUME, lastVolume: DEFAULT_VOLUME, pan: 0, solo: false, fx: newFx() });
      engine.setVolume(s.id, DEFAULT_VOLUME);
    }
    this.stems = st.sort((a, b) => orderIndex(a.stem) - orderIndex(b.stem) || a.stem.localeCompare(b.stem));
    this.stems.forEach((s, i) => this.poses.set(s.stem, defaultPose(i, this.stems.length)));
  }

  get hasVocals2() { return this.stems.some((s) => s.stem === 'vocals2'); }

  /** Posicion que ve el usuario: motor - latencia de salida - 130 ms. */
  get positionMs(): number {
    // El motor aplica el seek al renderizar: en pausa no se mueve. Hasta que llega, el destino
    // (seekTargetMs de PlayerActivity)
    const raw = this.engine.positionMs, tgt = this.seekTarget;
    if (tgt !== null) {
      if (!this.playing || (Math.abs(raw - tgt) > SEEK_LAND_MS && performance.now() - this.seekAt < SEEK_WAIT_MS)) return tgt;
      this.seekTarget = null;
    }
    const lat = (this.engine.ctx.outputLatency || this.engine.ctx.baseLatency || 0) * 1000;
    return Math.max(0, raw - (this.playing ? lat + BEAT_SYNC_OFFSET_MS : 0));
  }
  private seekTarget: number | null = null;
  private seekAt = 0;

  async play() { this.scheduleClicks(this.seekTarget ?? this.engine.positionMs); await this.engine.play(); this.playing = true; }
  pause() { this.engine.pause(); this.playing = false; this.engine.clearClicks(); } // cancelPendingDownbeats
  toggle() { return this.playing ? this.pause() : this.play(); }
  seek(ms: number) {
    const to = Math.min(Math.max(0, ms), this.durationMs);
    this.engine.seek(to);
    this.seekTarget = to; this.seekAt = performance.now();
    this.applyHalfPhase(to); // se reaplica en cada seek
    this.scheduleClicks(to);
  }
  skip(deltaMs: number) { this.seek((this.seekTarget ?? this.engine.positionMs) + deltaMs); }

  setVolume(stem: string, v: number) {
    const s = this.find(stem);
    s.volume = Math.round(Math.min(100, Math.max(0, v)));
    if (s.volume > 0) s.lastVolume = s.volume;
    this.engine.setVolume(s.id, s.volume, s.pan);
    this.onChange?.();
  }

  /** Balance -100..100 (se guarda). */
  setPan(stem: string, pan: number) {
    const s = this.find(stem);
    s.pan = Math.round(Math.min(100, Math.max(-100, pan)));
    this.engine.setVolume(s.id, s.volume, s.pan);
    this.onChange?.();
  }

  /** FX del stem; el filtro con zona muerta de +-3 alrededor del centro (como Android). */
  setFx(stem: string, patch: Partial<StemFx>) {
    const s = this.find(stem), f = Object.assign(s.fx, patch);
    if (patch.filter !== undefined) f.filter = Math.abs(patch.filter * 100) <= FILTER_DEAD_ZONE ? 0 : Math.max(-1, Math.min(1, patch.filter));
    this.engine.setFilter(s.id, f.filter);
    this.engine.setEcho(s.id, f.echo, echoDelayMs(this.bpm, f.echoDivision));
    this.engine.setReverb(s.id, Math.min(1, f.reverb), f.room);
  }

  /** Mute = slider a 0; quitar mute = ultimo volumen o 75. */
  toggleMute(stem: string) {
    const s = this.find(stem);
    this.setVolume(stem, s.volume > 0 ? 0 : (s.lastVolume || DEFAULT_VOLUME));
  }

  /** Solo multiple: con alguno activo, el resto queda silenciado por la puerta del motor. */
  toggleSolo(stem: string) {
    this.find(stem).solo = !this.find(stem).solo;
    const any = this.stems.some((s) => s.solo);
    for (const s of this.stems) this.engine.setSoloMuted(s.id, any && !s.solo);
  }

  setPitch(semi: number) {
    this.pitch = Math.round(Math.min(PITCH_MAX, Math.max(PITCH_MIN, semi)));
    // Bateria, percusion y metronomos no cambian de tono
    for (const s of this.stems) this.engine.setPitch(s.id, isPitched(s.stem) ? this.pitch : 0);
    this.onChange?.();
  }

  get targetBpm(): number | null { return this.bpm ? Math.round(this.bpm * this.tempoMult) : null; }

  /** Con BPM: 50..200 BPM. Sin BPM: 0.50..1.50x en pasos de 0.05. */
  setTempoBpm(target: number) {
    if (!this.bpm) return;
    this.setTempoMult(Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(target))) / this.bpm);
  }
  setTempoMult(m: number) {
    this.tempoMult = this.bpm ? m : Math.round(Math.min(MULT_MAX, Math.max(MULT_MIN, m)) / MULT_STEP) * MULT_STEP;
    this.engine.setTempo(this.tempoMult);
    this.onChange?.();
  }

  get hasMetronome() { return METRO_STEM.some((m) => m in this.metronomeIds); }

  setMetronome(on: boolean, speed: MetroSpeed = this.metroSpeed, volume = this.metroVolume) {
    this.metroOn = on; this.metroSpeed = speed; this.metroVolume = Math.round(Math.min(100, Math.max(0, volume)));
    // Solo suena el elegido, a metronomeVol/100
    METRO_STEM.forEach((m, i) => {
      const id = this.metronomeIds[m];
      if (id !== undefined) this.engine.setVolume(id, on && i === speed ? this.metroVolume : 0);
    });
    this.applyClick();
    this.onChange?.();
  }

  /** Downbeats de la cancion (celdas isDownbeat, en ms como (long)(time*1000f)). */
  setDownbeats(sec: number[]) {
    this.downbeats = sec.map((t) => Math.trunc(Math.fround(Math.fround(t) * 1000))); // float32 como Java
    this.applyClick();
  }

  /** Interruptor y sonido del click (ensureDownbeatSoundLoaded). `wav` nuevo = recargar; tras cada load hace falta. */
  setDownbeatSound(on: boolean, wav?: Uint8Array) {
    this.downbeatOn = on;
    if (wav) this.clickLoaded = this.engine.setClickWav(wav);
    this.applyClick();
  }

  /** Habilitar, pista que se atenua y cola desde la posicion actual (rescheduleClicksFromCurrentBeat). */
  private applyClick() {
    const on = this.downbeatOn && this.metroOn && this.clickLoaded;
    this.engine.setClickEnabled(on);
    const duck = on ? this.metronomeIds[METRO_STEM[this.metroSpeed]] : undefined;
    this.engine.setClickDuck(duck ?? -1);
    this.scheduleClicks(this.seekTarget ?? this.engine.positionMs);
  }

  /** Cola del motor: todos los downbeats que faltan (el motor dispara al cruzarlos, sample-accurate). */
  private scheduleClicks(fromMs: number) {
    this.engine.clearClicks();
    if (!this.downbeatOn || !this.metroOn || !this.clickLoaded) return;
    for (const ms of this.downbeats) if (ms > fromMs) this.engine.clickAt(ms);
  }

  setHalfVariantB(b: boolean) { this.metroHalfB = b; this.applyHalfPhase(this.engine.positionMs); this.onChange?.(); }

  /** Variante A: sin desfase. B: la pista 0.5x adelantada un beat local (pista en bucle). */
  private applyHalfPhase(songMs: number) {
    const id = this.metronomeIds[METRONOMES.half];
    if (id === undefined) return;
    const shift = this.metroHalfB ? localBeatIntervalMs(this.beats, songMs, this.bpm) : 0;
    this.engine.seekTrack(id, songMs + shift);
  }

  /** apply3DEnabled: pose, omni y mute antes de encender; al apagar vuelven volumen y balance. */
  set3DEnabled(on: boolean) {
    this.audio3d = on;
    for (const s of this.stems) {
      const p = this.poses.get(s.stem)!;
      if (on) { this.push3D(s.stem); this.engine.set3DOmni(s.id, p.omni); }
      this.engine.set3DEnabled(s.id, on);
      if (on) this.engine.set3DMuted(s.id, p.muted);
      else this.engine.setVolume(s.id, s.volume, s.pan);
    }
    this.onChange?.();
  }

  /** Escena 3D o vista plana: misma pose guardada, distinta distancia en el motor. */
  setFlat3D(on: boolean) {
    this.flat3d = on;
    if (this.audio3d) for (const s of this.stems) this.push3D(s.stem);
  }

  /** Cambia la pose; `save` = asentado (soltar, parar baile), no a 60 fps. */
  setPose(stem: string, patch: Partial<Pose3D>, save = true) {
    const p = this.poses.get(stem);
    if (!p) return;
    Object.assign(p, patch);
    this.push3D(stem);
    if (patch.omni !== undefined) this.engine.set3DOmni(this.find(stem).id, p.omni);
    if (patch.muted !== undefined) this.engine.set3DMuted(this.find(stem).id, p.muted);
    if (save) this.onChange?.();
  }

  /** El motor recibe esfericas: azimut, distancia real y elevacion en grados. */
  push3D(stem: string) {
    const p = this.poses.get(stem)!;
    if (this.flat3d) this.engine.set3DPosition(this.find(stem).id, p.az, flatDist(p), flatElevDeg(p));
    else this.engine.set3DPosition(this.find(stem).id, p.az, sphericalDist(p), elevRad(p) * 180 / Math.PI);
  }

  setChordsBasic(b: boolean) { this.chordsBasic = b; this.onChange?.(); }
  setChordsOnLyrics(on: boolean) { this.chordsOnLyrics = on; this.onChange?.(); }

  cycleRepeat() { this.repeat = ((this.repeat + 1) % 3) as Repeat; this.repeatOneUsed = false; }

  /** Llamar a menudo mientras suena. Devuelve que hacer si la cancion acabo (PlaybackService.handleSongEnded). */
  checkEnd(): EndResult | null {
    if (!this.playing || this.engine.positionMs < this.durationMs - 250) return null;
    if (this.repeat === Repeat.All) { this.seek(0); return 'looped'; } // seek reaplica la fase del 0.5x
    if (this.repeat === Repeat.One && !this.repeatOneUsed) { this.repeatOneUsed = true; this.seek(0); return 'looped'; }
    this.repeatOneUsed = false;
    if (this.repeat === Repeat.Off && this.autoplayNext) return 'next';
    this.pause();
    this.seek(0);
    return 'stopped';
  }

  private find(stem: string): StemState {
    const s = this.stems.find((x) => x.stem === stem);
    if (!s) throw new Error(`stem desconocido: ${stem}`);
    return s;
  }
}
