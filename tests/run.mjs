// Punto de entrada unico del arnes.
//   node tests/run.mjs            todas
//   node tests/run.mjs zip        solo las que casen (fichero o nombre de prueba)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tests } from './lib/harness.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const filter = (process.argv[2] || '').toLowerCase();
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();

let pass = 0, fail = 0, skip = 0;
const t0 = performance.now();
for (const f of files) {
  tests.length = 0;
  await import(pathToFileURL(path.join(dir, f)).href);
  const group = f.replace('.test.mjs', '');
  for (const t of tests) {
    const full = `${group} › ${t.name}`;
    if (filter && !full.toLowerCase().includes(filter)) continue;
    const ts = performance.now();
    try {
      const r = await t.fn();
      if (typeof r === 'string' && r.startsWith('skip')) { skip++; console.log(`  SALTA ${full}${r.slice(4)}`); continue; }
      pass++;
      console.log(`  OK    ${full}${r ? ` — ${r}` : ''} (${(performance.now() - ts).toFixed(0)} ms)`);
    } catch (e) {
      fail++;
      console.log(`  FALLA ${full}\n        ${e?.message ?? e}`);
    }
  }
}
console.log(`\n${pass} ok, ${fail} fallan, ${skip} saltadas (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
// Salir sin process.exit inmediato: en Windows rompe libuv con handles cerrandose (exit 127)
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 500);
