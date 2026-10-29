// Colores de portada: reglas de SongPalette (ventanas de luminancia/saturacion) sobre imagenes sinteticas.
import { test, expect, near } from './lib/harness.mjs';
import { rgbToHsl, hslToRgb, luminance, quantize, songColors } from '../src/player/songPalette.ts';

// Imagen RGBA de bandas: [[rgb, fraccion], ...] con ruido leve para que haya muchos colores
function img(bands, n = 112 * 112, noise = 0) {
  const out = new Uint8ClampedArray(n * 4);
  let i = 0, seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2 * noise;
  for (const [rgb, frac] of bands) {
    const cnt = Math.round(n * frac);
    for (let k = 0; k < cnt && i < n; k++, i++) { out.set([rgb[0] + rnd(), rgb[1] + rnd(), rgb[2] + rnd(), 255], i * 4); }
  }
  return out;
}

test('HSL ida y vuelta (ColorUtils)', () => {
  for (const c of [[39, 179, 151], [214, 174, 94], [10, 20, 200], [128, 128, 128]]) {
    const back = hslToRgb(rgbToHsl(c));
    expect(back.every((v, k) => Math.abs(v - c[k]) <= 1), `${c} -> ${back}`);
  }
});

test('cuantizador: pocos colores = exactos; muchos = como mucho maxColors, sin perder poblacion', () => {
  const few = quantize(img([[[200, 40, 60], 0.5], [[30, 60, 200], 0.5]]), 24);
  expect(few.length === 2, `swatches ${few.length}`);
  const many = quantize(img([[[200, 40, 60], 0.4], [[30, 60, 200], 0.3], [[40, 160, 60], 0.3]], 112 * 112, 40), 24);
  const pop = many.reduce((a, s) => a + s.population, 0);
  expect(many.length <= 24 && many.length > 3, `swatches ${many.length}`);
  expect(pop > 112 * 112 * 0.6, `poblacion ${pop}`);
});

test('portada gris: sin color -> null (se usa el acento elegido)', () => {
  expect(songColors(img([[[120, 120, 120], 0.6], [[40, 40, 40], 0.4]], 112 * 112, 6)) === null, 'deberia ser null');
});

test('portada con color: acento legible sobre negro, blobs apagados, secundario claro', () => {
  const c = songColors(img([[[200, 30, 70], 0.45], [[25, 40, 150], 0.35], [[230, 200, 60], 0.2]], 112 * 112, 20));
  expect(c, 'null con una portada de color');
  const [, s] = rgbToHsl(c.accent), y = luminance(c.accent);
  expect(y >= 0.195 && y <= 0.425 && s >= 0.49 && s <= 0.91, `acento Y=${y.toFixed(3)} S=${s.toFixed(2)}`);
  expect(luminance(c.secondary) >= 0.44, `secundario Y=${luminance(c.secondary).toFixed(3)}`);
  for (const b of c.blobs) { const [, bs, bl] = rgbToHsl(b); expect(bs <= 0.66 && bl >= 0.215 && bl <= 0.425, `blob S=${bs.toFixed(2)} L=${bl.toFixed(2)}`); }
  near(rgbToHsl(c.accent)[0], 340, 25, 'tono del acento: el rojo-magenta dominante');
  return `acento rgb(${c.accent}) Y=${y.toFixed(2)}`;
});
