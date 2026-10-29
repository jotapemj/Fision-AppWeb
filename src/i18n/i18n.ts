// Textos: claves de la app Android (android.json, generado por tools/import-strings.mjs)
// mas las propias de la web (web.json). Falta en un idioma -> ingles.
import android from './android.json' with { type: 'json' };
import web from './web.json' with { type: 'json' };

export const LANGS = ['en', 'es', 'ca', 'uk', 'pt-BR', 'fr', 'de', 'it', 'ru', 'zh-Hans'] as const;
export type Lang = (typeof LANGS)[number];

type Entry = string | Record<string, string>;
type Table = Record<string, Entry>;
const A = android as Record<string, Table>;
const W = web as Record<string, Table>;

/** Idioma del navegador mas cercano a los 10 de la app. */
export function pickLang(prefs: readonly string[]): Lang {
  for (const p of prefs) {
    const exact = LANGS.find((l) => l.toLowerCase() === p.toLowerCase());
    if (exact) return exact;
    if (/^zh\b/i.test(p)) return 'zh-Hans';
    const base = LANGS.find((l) => l.split('-')[0] === p.split('-')[0].toLowerCase());
    if (base) return base;
  }
  return 'en';
}

let lang: Lang = typeof navigator !== 'undefined' ? pickLang(navigator.languages ?? [navigator.language]) : 'en';
export const getLang = () => lang;
export function setLang(l: Lang) { lang = l; if (typeof document !== 'undefined') document.documentElement.lang = l; }

function lookup(key: string, l: Lang): Entry | undefined {
  return W[l]?.[key] ?? A[l]?.[key] ?? W.en?.[key] ?? A.en?.[key];
}

/** t('cloud_state_downloading', 42); plurales: t('search_result_count', {n: 3}). */
export function t(key: string, ...args: (string | number | { n: number })[]): string {
  const e = lookup(key, lang);
  if (e === undefined) return key;
  let s: string;
  let n: number | undefined;
  if (typeof e === 'string') s = e;
  else {
    const first = args[0];
    n = typeof first === 'object' ? first.n : Number(first);
    s = e[new Intl.PluralRules(lang).select(n)] ?? e.other ?? '';
  }
  return s.replace(/\{(\d+|n)\}/g, (m, k) => {
    if (k === 'n') return n !== undefined ? String(n) : m;
    const v = args[Number(k) - 1];
    return v === undefined || typeof v === 'object' ? m : String(v);
  });
}
