// Hojas de estilo: reglas que una captura no pilla.
import fs from 'node:fs';
import { test, expect } from './lib/harness.mjs';

test('hover solo con raton: en tactil el :hover se queda pegado tras tocar', () => {
  const css = fs.readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  const bad = css.split(/\r?\n/).filter((l) => l.includes(':hover') && !l.startsWith('@media (hover: hover)'));
  expect(bad.length === 0, `${bad.length} reglas sin envolver: ${bad[0] ?? ''}`);
});
