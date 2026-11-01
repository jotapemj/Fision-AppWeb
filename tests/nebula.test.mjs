// Nebulosa: semilla identica a Java, paleta del acento, reglas del pulso.
import { test, expect, near } from './lib/harness.mjs';
import { JavaRandom, orbits, accentPalette, pulseFor, decayPulse, brightnessCap, NEBULA_MAX_LUM } from '../src/player/nebulaMath.ts';

test('java.util.Random(1337).nextFloat() da la misma serie que Java', () => {
  // Generada con el JBR de Android Studio: new java.util.Random(1337), 9 x nextFloat()
  const want = [0.65992975, 0.17398947, 0.68924266, 0.87434816, 0.88327265, 0.9666088, 0.89850754, 0.8124872, 0.17456949];
  const r = new JavaRandom(1337);
  const got = want.map(() => r.nextFloat());
  got.forEach((v, i) => near(v, want[i], 5e-8, `nextFloat ${i}`));
  return `${got.length} valores iguales`;
});

test('orbitas: fases repartidas, blob 0 rapido, halos lentos', () => {
  const o = orbits();
  expect(o[0].freq >= 0.06 && o[0].freq <= 0.11 && o.slice(1).every((b) => b.freq >= 0.014 && b.freq <= 0.034), JSON.stringify(o));
  expect(o.every((b, i) => b.phase >= i * 2 * Math.PI / 3 && b.phase <= i * 2 * Math.PI / 3 + 0.6), 'fases');
});

test('paleta del acento: acento, +30 % blanco, +40 % negro', () => {
  const p = accentPalette('#27B397');
  expect(JSON.stringify(p.blobs) === JSON.stringify([[39, 179, 151], [104, 202, 182], [23, 107, 91]]), JSON.stringify(p.blobs));
});

test('pulso: 4/4, 3/4, medio tiempo por encima de 130 BPM, decaimiento', () => {
  expect([1, 2, 3, 4].map((b) => pulseFor(b, 4, 120)).join() === '0.35,0.9,0.35,0.9', '4/4');
  expect([1, 2, 3].map((b) => pulseFor(b, 3, 100)).join() === '0.95,0.3,0.3', '3/4');
  expect([1, 2, 3, 4].map((b) => pulseFor(b, 4, 176)).join() === '0.9,0,0.9,0', 'medio tiempo 4/4');
  expect([1, 2, 3].map((b) => pulseFor(b, 3, 150)).join() === '0.9,0,0', 'medio tiempo 3/4');
  near(decayPulse(1, 0.1), Math.exp(-0.7), 1e-9, 'decae a 7/s');
  expect(decayPulse(0.004, 0.01) === 0, 'suelo');
});

test('tope de brillo: el peor punto (todo sumado, pulso maximo, velo) no pasa del tope; una paleta oscura no se toca', () => {
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const worst = (p, k) => lum([0, 1, 2].map((ch) => Math.min(255, k * (p.blobs[0][ch] * 230 / 255 + (p.blobs[1][ch] + p.blobs[2][ch]) * 195 / 255 + p.anchor[ch] * 240 / 255)) * 0.6));
  const out = [];
  for (const a of ['#27B397', '#3B82F6', '#A855F7', '#F59E0B']) {
    const p = accentPalette(a), k = brightnessCap(p);
    expect(k > 0 && k < 1 && worst(p, k) <= NEBULA_MAX_LUM + 1e-6 && worst(p, k) > NEBULA_MAX_LUM * 0.95, `${a}: k ${k}, ${worst(p, k)}`);
    out.push(`${a} ${k.toFixed(2)}`);
  }
  const dark = { blobs: [[20, 10, 10], [15, 10, 10], [10, 5, 5]], anchor: [20, 10, 10] };
  expect(brightnessCap(dark) === 1, `paleta oscura: ${brightnessCap(dark)}`);
  return out.join(', ');
});
