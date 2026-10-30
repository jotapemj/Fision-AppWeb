// Export offline (modulo fision_export, build node): se mide la senal del render.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, expect } from './lib/harness.mjs';
import { sineWav } from './lib/zipWriter.mjs';
import { mixdown, renderStem, softLimit, trimTail, stemGains, wavPcm16, sanitize, timestamp, displayName, TAIL_SECONDS } from '../src/export/mixdown.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'engine/build/node/fision_export.mjs');
const SKIP = 'skip — falta engine/build/node/fision_export.mjs: `bash engine/build.sh export`';
const SR = 48000;

let M = null;
async function mod() {
  if (M) return M;
  if (!fs.existsSync(BUILD)) return null;
  const { default: create } = await import(pathToFileURL(BUILD).href);
  return (M = await create({ printErr: () => {} }));
}

const wav = (f, sec, amp = 0.3) => new Uint8Array(sineWav(f, sec, SR, amp));
const rms = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, to - from)); };
const peak = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const close = (a, b, tol) => Math.abs(a - b) <= tol;
const dry = null;

test('volumen y paneo como balance: por defecto 0.75; pan +40 baja la izquierda', () => {
  const [l0, r0] = stemGains(75, 0), [l, r] = stemGains(100, 40), [l2, r2] = stemGains(100, -100);
  expect(l0 === 0.75 && r0 === 0.75 && close(l, 0.6, 1e-9) && r === 1 && l2 === 1 && r2 === 0, `${l0},${r0} ${l},${r} ${l2},${r2}`);
});

test('mezcla seca: suma con su volumen por canal', async () => {
  const M = await mod(); if (!M) return SKIP;
  const a = { name: 'a.wav', bytes: wav(440, 2), volL: 1, volR: 0, fx: dry };
  const b = { name: 'b.wav', bytes: wav(660, 2), volL: 0, volR: 0.5, fx: dry };
  const r = mixdown(M, [a, b], null);
  const L = r.samples.filter((_, i) => i % 2 === 0), R = r.samples.filter((_, i) => i % 2 === 1);
  // Seno de amplitud .3 -> rms .212; R a la mitad
  expect(r.sr === SR && r.ch === 2 && L.length === 2 * SR, `formato ${r.sr} ${r.ch} ${L.length}`);
  expect(close(rms(L), 0.212, 0.005) && close(rms(R), 0.106, 0.005), `L ${rms(L).toFixed(3)} R ${rms(R).toFixed(3)}`);
  return `L ${rms(L).toFixed(3)}, R ${rms(R).toFixed(3)}`;
});

test('FX en el export: paso bajo apaga 5 kHz; el eco deja cola tras el stem', async () => {
  const M = await mod(); if (!M) return SKIP;
  const hi = { name: 'h.wav', bytes: wav(5000, 1), volL: 1, volR: 1 };
  const plain = mixdown(M, [{ ...hi, fx: dry }], null), lp = mixdown(M, [{ ...hi, fx: { filter: -0.8, echo: 0, echoMs: 500, reverb: 0, room: 1 } }], null);
  const db = 20 * Math.log10(rms(lp.samples, SR) / rms(plain.samples, SR));
  expect(db < -30, `paso bajo: ${db.toFixed(1)} dB`);
  const echo = mixdown(M, [{ ...hi, fx: { filter: 0, echo: 0.8, echoMs: 250, reverb: 0, room: 1 } }], null);
  const tail = rms(echo.samples, 2 * SR); // despues del final del stem (1 s)
  expect(echo.samples.length > 2 * SR && echo.samples.length <= 2 * SR * (1 + TAIL_SECONDS) && tail > 1e-3, `eco: ${echo.samples.length / 2 / SR} s, cola rms ${tail.toExponential(1)}`);
  return `paso bajo ${db.toFixed(0)} dB; eco ${(echo.samples.length / 2 / SR).toFixed(2)} s con cola`;
});

test('reverb sin eco: cola recortada al silencio (no los 6 s enteros)', async () => {
  const M = await mod(); if (!M) return SKIP;
  const r = mixdown(M, [{ name: 'r.wav', bytes: wav(440, 1), volL: 1, volR: 1, fx: { filter: 0, echo: 0, echoMs: 500, reverb: 0.6, room: 0 } }], null);
  const sec = r.samples.length / 2 / SR;
  expect(sec > 1 && sec < 1 + TAIL_SECONDS, `duracion ${sec.toFixed(2)} s`);
  return `${sec.toFixed(2)} s`;
});

test('metronomo encima a su volumen; el limitador deja el pico en 0.95', async () => {
  const M = await mod(); if (!M) return SKIP;
  const loud = { name: 'l.wav', bytes: wav(220, 1, 0.9), volL: 1, volR: 1, fx: dry };
  const r = mixdown(M, [loud, { ...loud, name: 'l2.wav' }], { name: 'metronome.wav', bytes: wav(1000, 1, 0.5), volume: 0.5 });
  expect(close(peak(r.samples), 0.95, 1e-6), `pico ${peak(r.samples)}`);
  const stem = renderStem(M, { name: 's.wav', bytes: wav(440, 1), fx: dry }, { name: 'metronome.wav', bytes: wav(1000, 1), volume: 1 });
  expect(rms(stem.samples) > 0.25, `stem + metronomo rms ${rms(stem.samples).toFixed(3)}`);
  return `pico ${peak(r.samples).toFixed(2)}`;
});

test('limitador = curva del motor; recorte de cola en frames enteros', () => {
  const b = new Float32Array([0.5, -0.7, 0.85, -1.2]);
  softLimit(b);
  // 0.85: over .5 -> .7 + .25 * .75 = .8875
  expect(b[0] === 0.5 && close(b[1], -0.7, 1e-6) && close(b[2], 0.8875, 1e-6) && close(b[3], -0.95, 1e-6), [...b].join());
  const t = trimTail(new Float32Array([1, 1, 1, 1, 0.5, 0, 0, 0, 0, 0]), 4, 2);
  expect(t.length === 6, `recorte ${t.length}`);
});

test('WAV PCM16, nombres y carpeta', () => {
  const w = wavPcm16({ samples: new Float32Array([0, 1, -1, 0.5]), sr: 44100, ch: 2 });
  const v = new DataView(w.buffer);
  expect(new TextDecoder().decode(w.subarray(0, 4)) === 'RIFF' && v.getUint32(24, true) === 44100 && v.getUint16(22, true) === 2 && v.getUint32(40, true) === 8, 'cabecera');
  expect(v.getInt16(46, true) === 32767 && v.getInt16(48, true) === -32767 && v.getInt16(50, true) === 16384, 'muestras');
  expect(sanitize('AC/DC: "Back"?') === 'AC_DC_ _Back__', sanitize('AC/DC: "Back"?'));
  expect(timestamp(new Date(2026, 9, 30, 9, 5, 7)) === '20261030_090507', timestamp(new Date(2026, 9, 30, 9, 5, 7)));
  expect(displayName('Airplane Mode', 'Josh Woodward', 'x.mp3') === 'Josh Woodward - Airplane Mode' && displayName('', '', 'pista.flac') === 'pista', 'displayName');
});
