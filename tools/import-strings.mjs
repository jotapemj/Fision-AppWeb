// Importa textos de la app Android (res/values*/strings.xml) a src/i18n/android.json.
// Solo las claves listadas en src/i18n/keys.json.
// Uso: node tools/import-strings.mjs <ruta a app/src/main/res>   (o FISION_ANDROID_RES)
// Placeholders: %1$s / %1$d / %d / %s -> {1}, {2}...  (%% -> %)
// <plurals> -> { one: "...", other: "..." } con {n} = la cantidad
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = process.argv[2] || process.env.FISION_ANDROID_RES;
if (!RES || !fs.existsSync(path.join(RES, 'values', 'strings.xml'))) {
  console.error('Uso: node tools/import-strings.mjs <app/src/main/res del repo Android> (o FISION_ANDROID_RES)');
  process.exit(2);
}

// Carpeta Android -> etiqueta BCP 47
const LANGS = { values: 'en', 'values-es': 'es', 'values-ca': 'ca', 'values-uk': 'uk', 'values-pt-rBR': 'pt-BR',
  'values-fr': 'fr', 'values-de': 'de', 'values-it': 'it', 'values-ru': 'ru', 'values-b+zh+Hans': 'zh-Hans' };

const keys = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/keys.json'), 'utf8'));

function unescape(s) {
  return s.trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\@/g, '@').replace(/\\\?/g, '?')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function placeholders(s, plural) {
  let seq = 0;
  return s.replace(/%(?:(\d+)\$)?([sd%])/g, (_, n, t) => {
    if (t === '%') return '%';
    if (plural && !n && t === 'd') return '{n}';
    return `{${n ? Number(n) : ++seq}}`;
  });
}

function parse(xml) {
  const out = {};
  for (const m of xml.matchAll(/<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) out[m[1]] = placeholders(unescape(m[2]), false);
  for (const m of xml.matchAll(/<plurals\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/plurals>/g)) {
    const forms = {};
    for (const it of m[2].matchAll(/<item\s+quantity="([a-z]+)"\s*>([\s\S]*?)<\/item>/g)) forms[it[1]] = placeholders(unescape(it[2]), true);
    out[m[1]] = forms;
  }
  return out;
}

const result = {};
const missing = [];
for (const [dir, tag] of Object.entries(LANGS)) {
  const file = path.join(RES, dir, 'strings.xml');
  if (!fs.existsSync(file)) { missing.push(`${tag} (sin ${dir})`); continue; }
  const all = parse(fs.readFileSync(file, 'utf8'));
  result[tag] = {};
  for (const k of keys) {
    if (k in all) result[tag][k] = all[k];
    else if (tag === 'en') missing.push(`${k} (falta en en: obligatorio)`);
  }
}
fs.writeFileSync(path.join(ROOT, 'src/i18n/android.json'), JSON.stringify(result, null, 1) + '\n');
console.log(`${keys.length} claves x ${Object.keys(result).length} idiomas -> src/i18n/android.json`);
if (missing.length) { console.log('Avisos:\n  ' + missing.join('\n  ')); if (missing.some((m) => m.includes('obligatorio'))) process.exit(1); }
