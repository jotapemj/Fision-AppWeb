// Ajustes globales (app_spec §1.1), en este navegador. Defaults = los de Android.
import type { Lang } from './i18n/i18n.ts';

export const ACCENTS = ['#27B397', '#3B82F6', '#A855F7', '#F59E0B'] as const; // accent_id 0..3

/** Sonidos del click de downbeat (DownbeatSounds de Android): public/dbclick/dbclick_<id>.wav, rotulo downbeat_sound_<id>. */
export const DOWNBEAT_SOUNDS = ['clap', 'glass', 'metronomebell', 'snap', 'stick', 'synthbella', 'synthbellb',
  'synthsquarea', 'synthsquareb', 'synthsquarec', 'tongue', 'weird', 'whistle'] as const;

export interface Settings {
  lang: Lang | '';          // '' = idioma del sistema
  accentId: number;         // accent_id
  songColors: boolean;      // song_colors_enabled
  nebula: boolean;          // nebula_enabled
  chordLatin: boolean;      // chord_notation_latin
  chordFlat: boolean;       // chord_prefer_flat
  chordTranspose: boolean;  // chord_transp_affects_view
  autoplayNext: boolean;    // autoplay_next
  sortAsc: boolean;         // songs_sort_order (0 = recientes primero)
  audio3dScene: boolean;    // audio3d_scene_enabled (Rendimiento): escena 3D o vista plana 2D
  downbeatSound: boolean;   // downbeat_sound_enabled (drawer del reproductor)
  downbeatType: number;     // downbeat_sound_type = indice de DOWNBEAT_SOUNDS
}

export const DEFAULTS: Settings = { lang: '', accentId: 0, songColors: false, nebula: false, chordLatin: false,
  chordFlat: false, chordTranspose: false, autoplayNext: false, sortAsc: false, audio3dScene: true,
  downbeatSound: false, downbeatType: 0 };

const KEY = 'fision.settings';
type Listener = (s: Settings, changed: keyof Settings) => void;

export class SettingsStore {
  private s: Settings;
  private listeners = new Set<Listener>();
  private storage: Pick<Storage, 'getItem' | 'setItem'> | null;

  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.storage = storage;
    let saved: Partial<Settings> = {};
    try { saved = JSON.parse(storage?.getItem(KEY) ?? '{}') ?? {}; } catch { saved = {}; }
    // Solo claves conocidas y del tipo correcto
    this.s = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (typeof saved[k] === typeof DEFAULTS[k]) (this.s as unknown as Record<string, unknown>)[k] = saved[k];
    }
    if (this.s.accentId < 0 || this.s.accentId >= ACCENTS.length) this.s.accentId = 0;
    if (!(this.s.downbeatType >= 0 && this.s.downbeatType < DOWNBEAT_SOUNDS.length)) this.s.downbeatType = 0;
  }

  get<K extends keyof Settings>(k: K): Settings[K] { return this.s[k]; }
  all(): Readonly<Settings> { return this.s; }

  set<K extends keyof Settings>(k: K, v: Settings[K]) {
    if (this.s[k] === v) return;
    this.s = { ...this.s, [k]: v };
    try { this.storage?.setItem(KEY, JSON.stringify(this.s)); } catch { /* sin storage */ }
    for (const l of this.listeners) l(this.s, k);
  }

  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}
