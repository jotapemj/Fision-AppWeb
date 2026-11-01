// Textos: claves completas en ingles, placeholders coherentes entre idiomas.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n', f), 'utf8'));
const keys = read('keys.json'), android = read('android.json'), web = read('web.json');
const holes = (e) => [...(typeof e === 'string' ? e : Object.values(e).join(' ')).matchAll(/\{(\d+|n)\}/g)].map((m) => m[1]).sort().filter((v, i, a) => a.indexOf(v) === i).join(',');

test('cada clave de keys.json esta en ingles', () => {
  const miss = keys.filter((k) => !(k in android.en));
  expect(!miss.length, `faltan en en: ${miss} (reimporta con tools/import-strings.mjs)`);
});

test('las claves web existen en los 10 idiomas', () => {
  const en = Object.keys(web.en), miss = [];
  for (const lang of Object.keys(android)) {
    const tab = web[lang] ?? {};
    for (const k of en) if (!(k in tab)) miss.push(`${lang}:${k}`);
    for (const k of Object.keys(tab)) if (!(k in web.en)) miss.push(`en:${k}`);
  }
  expect(!miss.length, `faltan ${miss.length}: ${miss.slice(0, 12).join(', ')}`);
});

test('cada t(\'clave\') del codigo existe (si no, se ve la clave en pantalla)', () => {
  const files = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }).filter((f) => /\.ts$/.test(f));
  const used = new Set();
  // Literales dentro de t(...): tambien t(on ? 'a_on' : 'a_off') y t(['x_a', 'x_b'][i])
  for (const f of files) for (const m of fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').matchAll(/\bt\(([^()]*)/g)) {
    for (const k of m[1].matchAll(/(?<!===?\s*)'([a-z0-9]+_[a-z0-9_]+)'/g)) used.add(k[1]); // no las comparaciones
  }
  const miss = [...used].filter((k) => !(k in android.en) && !(k in web.en));
  expect(!miss.length, `sin texto: ${miss.join(', ')}`);
  return `${used.size} claves usadas`;
});

test('mismos placeholders en todos los idiomas', () => {
  const bad = [];
  for (const [lang, tab] of Object.entries({ ...android, ...{} })) {
    for (const [k, v] of Object.entries(tab)) if (holes(v) !== holes(android.en[k])) bad.push(`${lang}:${k} ${holes(v)}≠${holes(android.en[k])}`);
  }
  for (const [lang, tab] of Object.entries(web)) for (const [k, v] of Object.entries(tab)) if (holes(v) !== holes(web.en[k] ?? '')) bad.push(`${lang}:${k}`);
  expect(!bad.length, bad.join('; '));
  return `${Object.keys(android).length} idiomas`;
});

test('t(): placeholders, plurales y caida a ingles', async () => {
  const { t, setLang, pickLang } = await import('../src/i18n/i18n.ts');
  setLang('es');
  expect(t('cloud_state_downloading', 42) === 'Descargando 42%', t('cloud_state_downloading', 42));
  expect(t('search_result_count', { n: 1 }) === '1 resultado', t('search_result_count', { n: 1 }));
  expect(t('search_result_count', { n: 3 }) === '3 resultados', t('search_result_count', { n: 3 }));
  setLang('ru');
  expect(t('search_result_count', { n: 3 }).startsWith('3 результата'), t('search_result_count', { n: 3 }));
  setLang('de');
  expect(t('pan_l') === 'L', `caida a en: ${t('pan_l')}`); // pan_l no existe en de
  expect(t('no_existe') === 'no_existe', 'clave desconocida');
  expect(pickLang(['pt-BR']) === 'pt-BR' && pickLang(['zh-CN']) === 'zh-Hans' && pickLang(['es-MX']) === 'es' && pickLang(['ja']) === 'en', 'pickLang');
});
