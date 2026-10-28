// Benchmark offline del motor WASM (Node, build de engine/build/node).
// Uso: node engine/bench.mjs <carpeta_con_flac> [hilos] [segundos]
import fs from 'node:fs';
import path from 'node:path';
import createFisionEngine from './build/node/fision_engine.mjs';

const [dir, thr = '8', sec = '30'] = process.argv.slice(2);
if (!dir) { console.error('Uso: node engine/bench.mjs <carpeta_con_flac> [hilos] [segundos]'); process.exit(2); }
const threads = Number(thr), seconds = Number(sec);
const SR = 48000, Q = 128;

const M = await createFisionEngine({ printErr: () => {} });
M._fe_create(SR);
M.FS.mkdir('/s');

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.flac') && !f.startsWith('metronome_'));
M._fe_load_clear();
for (const f of files) {
  M.FS.writeFile('/s/' + f, fs.readFileSync(path.join(dir, f)));
  const p = M.stringToNewUTF8('/s/' + f);
  M._fe_load_push(p);
  M._free(p);
}
const t0 = performance.now();
M._fe_load_run(threads);
while (M._fe_load_busy()) await new Promise((r) => setTimeout(r, 10));
const wall = performance.now() - t0;
let sum = 0;
files.forEach((f, i) => { sum += M._fe_load_ms(i); console.log(`  ${f.padEnd(16)} id=${M._fe_load_id(i)} ${M._fe_load_ms(i).toFixed(0)} ms`); });
for (const f of files) M.FS.unlink('/s/' + f);
console.log(`stems=${files.length} hilos=${threads}: carga ${wall.toFixed(0)} ms (suma por stem ${sum.toFixed(0)} ms)`);
console.log(`heap=${(M.wasmMemory.buffer.byteLength / 2 ** 20).toFixed(0)} MiB, duracion=${(M._fe_duration_ms() / 1000).toFixed(1)} s`);

const ids = files.map((_, i) => M._fe_load_id(i));
for (const id of ids) { M._fe_set_pitch(id, 2); M._fe_set_tempo(id, 1.1); M._fe_set_volume(id, 0.75, 0.75); }
M._fe_start();
const blocks = Math.ceil(seconds * SR / Q);
const times = new Float64Array(blocks);
let peak = 0;
const r0 = performance.now();
for (let b = 0; b < blocks; b++) {
  const tb = performance.now();
  const ptr = M._fe_render(Q);
  const out = new Float32Array(M.wasmMemory.buffer, ptr, Q * 2);
  for (let i = 0; i < Q * 2; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  times[b] = performance.now() - tb;
}
const dt = performance.now() - r0;
const budget = Q / SR * 1000;
const s = [...times].sort((a, b) => a - b);
console.log(`render ${seconds}s: carga CPU ${(dt / (seconds * 1000) * 100).toFixed(1)}% de un nucleo, pico=${peak.toFixed(3)}, pos=${(M._fe_position_ms() / 1000).toFixed(2)} s`);
console.log(`bloque p50=${s[blocks >> 1].toFixed(3)} p99=${s[Math.floor(blocks * 0.99)].toFixed(3)} max=${s[blocks - 1].toFixed(2)} ms; >presupuesto(${budget.toFixed(2)})=${times.filter((t) => t > budget).length}/${blocks}`);
process.exit(0);
