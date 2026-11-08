// Hojas de estilo: reglas que una captura no pilla.
import fs from 'node:fs';
import { test, expect } from './lib/harness.mjs';

test('hover solo con raton: en tactil el :hover se queda pegado tras tocar', () => {
  const css = fs.readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  const bad = css.split(/\r?\n/).filter((l) => l.includes(':hover') && !l.startsWith('@media (hover: hover)'));
  expect(bad.length === 0, `${bad.length} reglas sin envolver: ${bad[0] ?? ''}`);
});

test('iconos dibujados, no caracteres de texto (✕ ← ⋯ ▾ ✓ + − ⠿ como icono)', () => {
  const dir = new URL('../src/ui/', import.meta.url);
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    fs.readFileSync(new URL(f, dir), 'utf8').split(/\r?\n/).forEach((l, i) => {
      // Un glifo solo (o pegado a un texto) como contenido de un elemento
      if (/textContent: (['`])[^'`]*[✕←⋯▾✓⠿][^'`]*\1|textContent: '[+−]'/.test(l) || /'[✕←⋯▾✓⠿]'/.test(l) || /`[^`]*[←▾✓]\s*\$\{|\}\s*[←▾✓]`/.test(l)) bad.push(`${f}:${i + 1}`);
    });
  }
  expect(!bad.length, `${bad.length} iconos de texto: ${bad.join(', ')}`);
});

test('el texto sobre el acento sigue a --on-accent (con colores de portada pasa a negro)', () => {
  const css = fs.readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  const bad = css.split(/\r?\n/).filter((l) => /rgba?\(\s*4\s*,\s*20\s*,\s*15|#04140f/i.test(l) && !/^\s*--on-accent:/.test(l));
  expect(!bad.length, `${bad.length} con el valor fijo: ${bad[0] ?? ''}`);
});

test('sin seleccion de texto en la app: solo los campos de texto', () => {
  const css = fs.readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  expect(/^body \{[^}]*\buser-select: none/m.test(css), 'body sin user-select: none');
  expect(/^input, textarea \{[^}]*\buser-select: text/m.test(css), 'los campos deben poder seleccionarse');
});
