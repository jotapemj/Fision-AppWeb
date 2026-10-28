// Lector de ZIP contra zips construidos aqui (stored y deflate).
import zlib from 'node:zlib';
import { test, expect } from './lib/harness.mjs';
import { listZip, readZipEntry } from '../src/lib/zip.ts';

// Escritor minimo de ZIP para la prueba
function makeZip(files) {
  const locals = [], cens = [];
  let off = 0;
  for (const { name, data, deflate } of files) {
    const n = Buffer.from(name), body = deflate ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data), method = deflate ? 8 : 0;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(body.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(n.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(off, 42);
    locals.push(loc, n, body); cens.push(cen, n);
    off += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(cens), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

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
