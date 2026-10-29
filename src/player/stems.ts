// Catalogo de stems: calco de StemSpec.java (orden, tono, titulo). Iconos en ui/stemIcons.ts.

export const ORDER = ['vocals', 'vocals2', 'bass', 'drums', 'other', 'instrumental', 'piano', 'guitar', 'winds',
  'perc', 'kick', 'snare', 'toms', 'hh', 'ride', 'crash'] as const;
export const DRUM_PARTS = ['kick', 'snare', 'toms', 'hh', 'ride', 'crash'];
const PITCHED = new Set(['vocals', 'vocals2', 'bass', 'other', 'instrumental', 'piano', 'guitar', 'winds']);
export const METRONOMES = { half: 'metronome_half', one: 'metronome', double: 'metronome_double' } as const;

export const DEFAULT_VOLUME = 75;

/** Nombre de stem desde el fichero: "vocals2.flac" -> "vocals2". */
export const stemOf = (file: string) => file.replace(/\.(flac|wav)$/i, '');
export const isMetronome = (stem: string) => stem.startsWith('metronome');
export const isDrumPart = (stem: string) => DRUM_PARTS.includes(stem);
export const isPitched = (stem: string) => PITCHED.has(stem);
export const orderIndex = (stem: string) => { const i = (ORDER as readonly string[]).indexOf(stem); return i < 0 ? ORDER.length : i; };

/** Clave i18n del titulo; vocals cambia si hay coros. */
export function titleKey(stem: string, hasVocals2: boolean): string {
  if (stem === 'vocals') return hasVocals2 ? 'title_main_vocals' : 'title_vocals';
  const k: Record<string, string> = { vocals2: 'title_chorus', drums: 'title_drums', bass: 'title_bass', other: 'title_other',
    instrumental: 'title_accompaniment', guitar: 'title_guitar', piano: 'title_piano', winds: 'title_winds', kick: 'title_kick',
    snare: 'title_snare', hh: 'title_hh', crash: 'title_crash', ride: 'title_ride', toms: 'title_toms', perc: 'title_perc' };
  return k[stem] ?? '';
}
