// Canciones descargadas (OPFS imitado en una carpeta temporal propia).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './lib/harness.mjs';
import { dirHandle } from './lib/fakeOpfs.mjs';
import { SongStore } from '../src/lib/songStore.ts';

const H = 'a'.repeat(64), H2 = 'b'.repeat(64);
const files = [{ name: 'bass.flac', data: new Uint8Array([1, 2, 3]) }, { name: 'chords.txt', data: new TextEncoder().encode('0.0 C') }];

async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fision-store-'));
  try { return await fn(dir, (user) => new SongStore(user, async () => dirHandle(dir))); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('guardar, version, listar y leer', () => withTmp(async (_, store) => {
  const s = store('demo');
  await s.save(H, '2026-10-27T19:32:45+00:00', files);
  expect((await s.version(H)) === '2026-10-27T19:32:45+00:00', 'version');
  expect((await s.list()).join() === H, 'lista');
  const got = await s.load(H, (n) => n.endsWith('.flac'));
  expect(got.length === 1 && got[0].name === 'bass.flac' && got[0].data[2] === 3, 'contenido');
}));

test('descarga cortada (sin .complete) no cuenta y se rehace', () => withTmp(async (dir, store) => {
  const s = store('demo');
  await s.list(); // crea acc_demo
  const half = path.join(dir, 'acc_demo', H);
  fs.mkdirSync(half); fs.writeFileSync(path.join(half, 'bass.flac'), 'x');
  expect((await s.version(H)) === null, 'version deberia ser null');
  expect((await s.list()).length === 0, 'no deberia listarse');
  let code = '';
  try { await s.load(H); } catch (e) { code = e.message; }
  expect(code === 'not_downloaded', `load: ${code}`);
  await s.save(H, 'v2', files);
  expect((await s.version(H)) === 'v2' && fs.readdirSync(half).length === 3, 'rehecha');
}));

test('rechaza nombres con ruta (zip-slip) sin escribir nada', () => withTmp(async (dir, store) => {
  const s = store('demo');
  let code = '';
  try { await s.save(H, 'v1', [{ name: '../evil.flac', data: new Uint8Array(1) }]); } catch (e) { code = e.message; }
  expect(code === 'bad_entry_name', code);
  expect(!fs.existsSync(path.join(dir, 'acc_demo', H)), 'carpeta creada');
  expect(!fs.existsSync(path.join(dir, 'evil.flac')), 'escapo de la carpeta');
}));

test('cada cuenta ve solo lo suyo; borrar', () => withTmp(async (_, store) => {
  const a = store('demo'), b = store('jp');
  await a.save(H, 'v1', files);
  await b.save(H2, 'v1', files);
  expect((await a.list()).join() === H && (await b.list()).join() === H2, 'aislamiento');
  await a.remove(H);
  await a.remove(H); // dos veces no falla
  expect((await a.list()).length === 0, 'borrado');
}));
