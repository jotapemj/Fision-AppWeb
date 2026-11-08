// Idiomas de la transcripcion (LyricsLanguage de Android): Auto (null = lo decide Whisper) + 27.
// Banderas convertidas de los vectores de Android; hi, pa y ta comparten la de India.
import generic from '../assets/artcover_generic.png'; // Auto = el logo generico (como Android)
const flags = import.meta.glob('../assets/flags/*.{svg,png}', { eager: true, import: 'default' }) as Record<string, string>;
const flag = (n: string) => n === 'flag_auto' ? generic : flags[`../assets/flags/${n}.svg`] ?? flags[`../assets/flags/${n}.png`] ?? '';

export interface LyricsLang { code: string | null; key: string; flag: string }

const TABLE: [string | null, string][] = [
  [null, 'auto'], ['en', 'gb'], ['es', 'es'], ['pt', 'br'], ['ja', 'jp'], ['ko', 'kr'], ['hi', 'in'], ['fr', 'fr'], ['zh', 'cn'],
  ['de', 'de'], ['it', 'it'], ['ar', 'sa'], ['ru', 'ru'], ['tr', 'tr'], ['id', 'id'], ['pa', 'in'], ['sv', 'se'], ['nl', 'nl'],
  ['vi', 'vn'], ['tl', 'ph'], ['el', 'gr'], ['th', 'th'], ['fa', 'ir'], ['he', 'il'], ['ta', 'in'], ['ca', 'ca'], ['uk', 'ua'], ['pl', 'pl'],
];

/** LANGUAGES[0] es siempre Auto. El elegido no se guarda: cada cancion empieza en Auto (decision JP). */
export const LYRICS_LANGS: LyricsLang[] = TABLE.map(([code, f]) => ({ code, key: `lyrics_lang_${code ?? 'auto'}`, flag: flag(`flag_${f}`) }));
