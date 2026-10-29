// Nebulosa: semilla identica a Java, paleta del acento, reglas del pulso.
import { test, expect, near } from './lib/harness.mjs';
import { JavaRandom, orbits, accentPalette, pulseFor, decayPulse } from '../src/player/nebulaMath.ts';

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
