// Lector de ZIP contra zips construidos aqui (stored y deflate).
import { test, expect } from './lib/harness.mjs';
import { listZip, readZipEntry } from '../src/lib/zip.ts';
import { makeZip } from './lib/zipWriter.mjs';

const rnd = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 7 + (i >> 5)) & 255; return b; };

test('lee entradas stored y deflate byte a byte', async () => {
  const a = rnd(100_000), b = Buffer.from('{"x":1}'.repeat(5000));
  const zip = makeZip([{ name: 'bass.flac', data: a }, { name: 'lyrics.json', data: b, deflate: true }]);
  const es = listZip(zip);
  expect(es.map((e) => e.name).join() === 'bass.flac,lyrics.json', `nombres: ${es.map((e) => e.name)}`);
  const ra = await readZipEntry(zip, es[0]), rb = await readZipEntry(zip, es[1]);
  expect(Buffer.compare(Buffer.from(ra), a) === 0, 'stored distinto');
  expect(Buffer.compare(Buffer.from(rb), b) === 0, 'deflate distinto');
  return `${es[1].compSize} -> ${es[1].size} bytes`;
});

test('rechaza lo que no es zip', async () => {
  let code = '';
  try { listZip(new Uint8Array(1000)); } catch (e) { code = e.message; }
  expect(code === 'zip_invalid', `codigo: ${code}`);
});
