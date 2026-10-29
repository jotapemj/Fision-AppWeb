// Motor WASM (build node): se mide la senal renderizada, no el codigo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, expect, near } from './lib/harness.mjs';
import { sineWav as wav } from './lib/zipWriter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'engine/build/node/fision_engine.mjs');
const SR = 48000;

let M = null;
async function engine() {
  if (M) return M;
  if (!fs.existsSync(BUILD)) return null;
  const { default: create } = await import(pathToFileURL(BUILD).href);
  M = await create({ printErr: () => {} });
  M.FS.mkdir('/t');
  return M;
}

const sineWav = (f, sec) => wav(f, sec, SR);

// Carga en paralelo como la web; devuelve ids por fichero
async function load(freqs, threads = 4, seconds = 6) {
  expect(M._fe_create(SR) === 1, 'fe_create rechazado');
  M._fe_load_clear();
  freqs.forEach((f, i) => {
    const p = `/t/s${i}.wav`;
    M.FS.writeFile(p, sineWav(f, seconds));
    const s = M.stringToNewUTF8(p); M._fe_load_push(s); M._free(s);
  });
  M._fe_load_run(threads);
  while (M._fe_load_busy()) await new Promise((r) => setTimeout(r, 5));
  freqs.forEach((_, i) => M.FS.unlink(`/t/s${i}.wav`));
  return freqs.map((_, i) => M._fe_load_id(i));
}

// Renderiza `seconds` y devuelve el canal L
function render(seconds) {
  const frames = Math.round(SR * seconds), Q = 128, L = new Float32Array(frames);
  for (let o = 0; o < frames; o += Q) {
    const ptr = M._fe_render(Q);
    const out = new Float32Array(M.wasmMemory.buffer, ptr, Q * 2);
    for (let i = 0; i < Q && o + i < frames; i++) L[o + i] = out[2 * i];
  }
  return L;
}

// Frecuencia por cruces por cero ascendentes
function freqOf(x) {
  let c = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) c++;
  return c / (x.length / SR);
}
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

const SKIP = 'skip — falta engine/build/node: compila con `npm run engine` (necesita emsdk)';
const needEngine = async () => (await engine()) ? null : SKIP;

test('suena el seno a su frecuencia', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const [id] = await load([440]);
  M._fe_set_volume(id, 1, 1); M._fe_start();
  render(0.5); // calentar SoundTouch
  const f = freqOf(render(1));
  near(f, 440, 4, 'frecuencia');
  return `${f.toFixed(1)} Hz`;
});

test('tono +12 dobla la frecuencia', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const [id] = await load([440]);
  M._fe_set_volume(id, 1, 1); M._fe_set_pitch(id, 12); M._fe_start();
  render(0.5);
  const f = freqOf(render(1));
  near(f, 880, 9, 'frecuencia con +12');
  return `${f.toFixed(1)} Hz`;
});

test('tempo 2x avanza el doble sin cambiar tono', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const [id] = await load([440]);
  M._fe_set_volume(id, 1, 1); M._fe_set_tempo(id, 2); M._fe_start();
  render(0.5);
  const p0 = M._fe_position_ms();
  const f = freqOf(render(1));
  const adv = M._fe_position_ms() - p0;
  near(adv, 2000, 60, 'avance en 1 s');
  near(f, 440, 6, 'frecuencia a 2x');
  return `avance ${adv.toFixed(0)} ms, ${f.toFixed(1)} Hz`;
});

test('volumen escala la senal (lineal, como Android)', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const [id] = await load([440]);
  M._fe_set_volume(id, 1, 1); M._fe_start();
  render(0.5);
  const a = rms(render(0.5));
  M._fe_set_volume(id, 0.5, 0.5);
  render(0.1); // rampa
  const b = rms(render(0.5));
  near(b / a, 0.5, 0.03, 'razon de nivel');
  return `razon ${(b / a).toFixed(3)}`;
});

test('carga en paralelo: cada id es su fichero', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const freqs = [220, 330, 440, 550, 660, 770];
  const ids = await load(freqs, 4, 8); // 6 x 0.7 s renderizados: que no se acabe
  expect(new Set(ids).size === freqs.length && ids.every((i) => i >= 0), `ids: ${ids}`);
  M._fe_start();
  const got = [];
  for (let k = 0; k < freqs.length; k++) {
    ids.forEach((id, j) => M._fe_set_volume(id, j === k ? 1 : 0, j === k ? 1 : 0));
    render(0.3);
    const f = freqOf(render(0.4));
    near(f, freqs[k], 6, `stem ${k}`);
    got.push(f.toFixed(0));
  }
  return `ids ${ids.join(',')} -> ${got.join(', ')} Hz`;
});

test('stemGains replica el paneo de Android', async () => {
  const { stemGains } = await import(pathToFileURL(path.join(ROOT, 'src/engine/engine.ts')).href);
  const cases = [[[75, 0], [0.75, 0.75]], [[100, 50], [0.5, 1]], [[100, -50], [1, 0.5]], [[80, 100], [0, 0.8]], [[0, 30], [0, 0]]];
  for (const [[v, p], [l, r]] of cases) {
    const [gl, gr] = stemGains(v, p);
    near(gl, l, 1e-6, `L(${v},${p})`); near(gr, r, 1e-6, `R(${v},${p})`);
  }
});
