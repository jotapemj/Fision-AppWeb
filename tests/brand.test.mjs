// Marca animada: el spinner y el cierre cumplen las reglas de FisionMotion.
import { test, expect, near } from './lib/harness.mjs';
import { steady, closePlan, closeArc, warp, MIN_SPIN } from '../src/brand/fisionMotion.ts';

test('spinner: cabeza siempre por delante de la cola y ambos avanzan', () => {
  let prev = steady(0);
  for (let u = 10; u <= 5000; u += 10) {
    const s = steady(u);
    const f = s[0] - s[1];
    expect(f >= 0.079 && f <= 0.701, `longitud del arco ${f.toFixed(3)} en ${u} ms`);
    expect(s[0] >= prev[0] - 1e-9 && s[1] >= prev[1] - 1e-9, `retrocede en ${u} ms`);
    prev = s;
  }
});

test('cierre desde cualquier instante: anillo entero en las 12, sin rebasar', () => {
  for (let u0 = MIN_SPIN; u0 <= 4000; u0 += 37) {
    const p = closePlan(u0);
    expect(Math.abs(p.t1 - Math.round(p.t1)) < 1e-6, `cola cierra en vuelta entera: ${p.t1}`);
    const end = closeArc(p, p.dur);
    near(end[0] - end[1], 1, 1e-6, `anillo cerrado (u0=${u0})`);
    // La cola nunca pasa el punto final (Hermite monotono)
    for (let t = 0; t <= p.dur; t += p.dur / 40) expect(closeArc(p, t)[1] <= p.t1 + 1e-6, `rebasa en t=${t}`);
  }
});

test('warp: rampa continua de 1x a 2x en 150 ms', () => {
  near(warp(0), 0, 1e-9, 'origen');
  near(warp(150), 150 + 75, 1e-9, 'fin de rampa');
  near(warp(1150) - warp(1149), 2, 1e-9, 'velocidad final 2x');
  near(warp(1) - warp(0), 1, 0.01, 'velocidad inicial 1x');
});
