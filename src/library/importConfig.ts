// Subir y reprocesar (ImportActivity de Android): separacion 4 stems / 2 stems / personalizada,
// config_json "rico", comprobaciones antes de subir y textos de error por codigo. Sin DOM.

export const TILE_STEMS = ['vocals', 'guitar', 'bass', 'drums', 'piano', 'winds'] as const;
export type TileStem = (typeof TILE_STEMS)[number];
export const LOCKED_STEM: TileStem = 'vocals'; // siempre seleccionado
const PRESET_4: TileStem[] = ['vocals', 'bass', 'drums'];
const PRESET_2: TileStem[] = ['vocals'];

export const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aiff', 'aif', 'wma'];
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // FISION_MAX_UPLOAD_MB por defecto
export const MIN_AUDIO_SEC = 15;
/** Errores de job que se pueden reintentar con el mismo config (dialogo de Android). */
export const RETRYABLE = ['gpu_busy', 'timeout'];

export type SepMode = '4stem' | '2stem' | 'custom';

/** Estado de la separacion. El conjunto personalizado sobrevive a ir y volver de un preset. */
export interface SepState { mode: SepMode; custom: Set<TileStem>; vocalsSplit: boolean; drumsSplit: boolean }

export const newSep = (): SepState => ({ mode: '4stem', custom: new Set(PRESET_4), vocalsSplit: false, drumsSplit: false });

export function isSelected(s: SepState, stem: TileStem): boolean {
  if (s.mode === '4stem') return PRESET_4.includes(stem);
  if (s.mode === '2stem') return PRESET_2.includes(stem);
  return s.custom.has(stem);
}
export const vocalsSplit = (s: SepState) => s.mode === 'custom' && s.vocalsSplit;
export const drumsSplit = (s: SepState) => s.mode === 'custom' && s.drumsSplit;
/** Nombre del resto de la mezcla: acompanamiento en 2 stems, "otros" si no. */
export const restKey = (s: SepState) => (s.mode === '2stem' ? 'title_accompaniment' : 'title_other');

/** Tocar un tile en un preset pasa a personalizada partiendo de los stems del preset. */
function enterCustom(s: SepState) {
  if (s.mode === 'custom') return;
  s.custom = new Set(s.mode === '2stem' ? PRESET_2 : PRESET_4);
  s.vocalsSplit = false; s.drumsSplit = false;
  s.mode = 'custom';
}

export function tapTile(s: SepState, stem: TileStem) {
  if (stem === LOCKED_STEM) return;
  enterCustom(s);
  if (!s.custom.delete(stem)) s.custom.add(stem);
}

/** Elegir variante tambien selecciona el stem; la que ya se ve en uno elegido no cambia nada. */
export function tapVariant(s: SepState, stem: 'vocals' | 'drums', split: boolean) {
  const cur = stem === 'vocals' ? vocalsSplit(s) : drumsSplit(s);
  if (cur === split && isSelected(s, stem)) return;
  enterCustom(s);
  if (stem === 'vocals') s.vocalsSplit = split; else s.drumsSplit = split;
  s.custom.add(stem);
}

const serverKey = (stem: TileStem) => (stem === 'winds' ? 'brass' : stem);

/** buildConfig: device segun /server/info (sin dato = cpu); acordes siempre btc. */
export function buildConfig(s: SepState, gpu: boolean): Record<string, unknown> {
  let sep: Record<string, unknown>;
  if (s.mode !== 'custom') {
    const four = s.mode === '4stem';
    sep = { mode: 'classic', preset: four ? '4stem' : '2stem', sep_mode: four ? 4 : 2 };
  } else {
    const stems: Record<string, unknown> = {};
    for (const st of TILE_STEMS) {
      if (st === LOCKED_STEM) continue;
      stems[serverKey(st)] = st === 'drums' ? { enabled: s.custom.has(st), variant: s.drumsSplit ? 'split' : 'full' } : { enabled: s.custom.has(st) };
    }
    sep = { mode: 'personalized', vocals: s.vocalsSplit ? 'split' : 'single', stems };
  }
  return { sep, device: gpu ? 'cuda' : 'cpu', chords: 'btc' };
}

/** prefillFromConfig: el config vigente de la cancion -> estado (para reprocesar). */
export function sepFromConfig(cfg: unknown): SepState {
  const s = newSep();
  const sep = (cfg as { sep?: Record<string, unknown> } | null)?.sep;
  if (!sep || typeof sep !== 'object') return s;
  if (sep.mode === 'classic') {
    s.mode = sep.preset === '4stem' || sep.sep_mode === 4 ? '4stem' : '2stem';
  } else if (sep.mode === 'personalized') {
    s.mode = 'custom';
    s.vocalsSplit = sep.vocals === 'split';
    s.custom = new Set<TileStem>([LOCKED_STEM]);
    const stems = (sep.stems ?? {}) as Record<string, { enabled?: unknown; variant?: unknown }>;
    for (const st of TILE_STEMS) if (st !== LOCKED_STEM && stems[serverKey(st)]?.enabled === true) s.custom.add(st);
    s.drumsSplit = stems.drums?.variant === 'split';
  }
  return s;
}

export const extOf = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

/** Antes de subir: formato, tamano, vacio y duracion (null si no se pudo leer). [clave, args] o null. */
export function checkFile(name: string, size: number, durationSec: number | null): [string, ...number[]] | null {
  if (!AUDIO_EXTS.includes(extOf(name))) return ['import_err_unsupported_format'];
  if (size === 0) return ['import_err_empty'];
  if (size > MAX_UPLOAD_BYTES) return ['import_err_too_large'];
  if (durationSec !== null && durationSec < MIN_AUDIO_SEC) return ['import_err_too_short', MIN_AUDIO_SEC];
  return null;
}

/** uploadErrorMessage de Android. */
export function uploadErrorKey(status: number, code: string): [string, ...(string | number)[]] {
  if (status === 0) return ['import_upload_failed'];
  switch (status) {
    case 415: return ['import_err_unsupported_format'];
    case 413: return ['import_err_too_large'];
    case 429: return ['err_job_limit'];
    case 401: return ['login_session_expired'];
    case 400:
      if (code === 'audio_empty') return ['import_err_empty'];
      if (code === 'audio_too_short') return ['import_err_too_short', MIN_AUDIO_SEC];
      return ['import_err_internal'];
    default: return ['web_upload_failed_status', status];
  }
}

export function reprocessErrorKey(status: number): [string] {
  if (status === 409) return ['reprocess_busy'];
  if (status === 429) return ['err_job_limit'];
  if (status === 404) return ['reprocess_missing_input'];
  if (status === 0) return ['import_upload_failed'];
  return ['reprocess_failed'];
}

/** Subtitulo de una fila en error: job_err_<code>; desconocido = "Error". */
export const jobErrorKey = (code: string | null | undefined) =>
  code && ['cancelled', 'gpu_busy', 'timeout', 'pipeline_failed', 'lyrics_failed', 'input_missing', 'vocals_missing', 'internal'].includes(code) ? `job_err_${code}` : 'cloud_state_error';

/** "5:55 · FLAC · 41.0 MB" (linea meta de la tarjeta). */
export function fileMeta(name: string, size: number, durationSec: number | null): string {
  const parts: string[] = [];
  if (durationSec !== null && Number.isFinite(durationSec)) { const s = Math.round(durationSec); parts.push(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`); }
  if (extOf(name)) parts.push(extOf(name).toUpperCase());
  parts.push(`${(size / 1024 / 1024).toFixed(1)} MB`);
  return parts.join(' · ');
}
