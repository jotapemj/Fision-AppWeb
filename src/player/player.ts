// Estado y reglas del reproductor (sin DOM). Reglas de app_spec §3.
import type { Engine, LoadedStem } from '../engine/engine.ts';
import { DEFAULT_VOLUME, isMetronome, isPitched, METRONOMES, orderIndex, stemOf } from './stems.ts';

// repeat_mode de Android
export const Repeat = { Off: 0, All: 1, One: 2 } as const;
export type Repeat = (typeof Repeat)[keyof typeof Repeat];

export interface StemState {
  stem: string;
  id: number;
  volume: number;     // 0..100 (mute = 0)
  lastVolume: number; // para quitar mute
  pan: number;        // -100..100
  solo: boolean;      // no se guarda
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
  pitch = 0;
  tempoMult = 1;
  repeat: Repeat = Repeat.Off;
  autoplayNext = false;
  playing = false;
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
      st.push({ stem, id: s.id, volume: DEFAULT_VOLUME, lastVolume: DEFAULT_VOLUME, pan: 0, solo: false });
      engine.setVolume(s.id, DEFAULT_VOLUME);
    }
    this.stems = st.sort((a, b) => orderIndex(a.stem) - orderIndex(b.stem) || a.stem.localeCompare(b.stem));
  }

  get hasVocals2() { return this.stems.some((s) => s.stem === 'vocals2'); }

  /** Posicion que ve el usuario: motor - latencia de salida - 130 ms. */
  get positionMs(): number {
    const lat = (this.engine.ctx.outputLatency || this.engine.ctx.baseLatency || 0) * 1000;
    return Math.max(0, this.engine.positionMs - (this.playing ? lat + BEAT_SYNC_OFFSET_MS : 0));
  }

  async play() { await this.engine.play(); this.playing = true; }
  pause() { this.engine.pause(); this.playing = false; }
  toggle() { return this.playing ? this.pause() : this.play(); }
  seek(ms: number) {
    const to = Math.min(Math.max(0, ms), this.durationMs);
    this.engine.seek(to);
    this.applyHalfPhase(to); // se reaplica en cada seek
  }
  skip(deltaMs: number) { this.seek(this.engine.positionMs + deltaMs); }

  setVolume(stem: string, v: number) {
    const s = this.find(stem);
    s.volume = Math.round(Math.min(100, Math.max(0, v)));
    if (s.volume > 0) s.lastVolume = s.volume;
    this.engine.setVolume(s.id, s.volume, s.pan);
    this.onChange?.();
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
    this.onChange?.();
  }

  setHalfVariantB(b: boolean) { this.metroHalfB = b; this.applyHalfPhase(this.engine.positionMs); this.onChange?.(); }

  /** Variante A: sin desfase. B: la pista 0.5x adelantada un beat local (pista en bucle). */
  private applyHalfPhase(songMs: number) {
    const id = this.metronomeIds[METRONOMES.half];
    if (id === undefined) return;
    const shift = this.metroHalfB ? localBeatIntervalMs(this.beats, songMs, this.bpm) : 0;
    this.engine.seekTrack(id, songMs + shift);
  }

  setChordsBasic(b: boolean) { this.chordsBasic = b; this.onChange?.(); }

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
