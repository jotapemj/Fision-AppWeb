// Diagramas de acordes: simbolo, formas de chords-db, eleccion de posicion y teclas de piano.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/harness.mjs';
import { ChordShapes, parseSymbol, pickVoicing, pianoKeys, chordChanges, assignVoicings, changeAt, noteName, ZONE_AUTO } from '../src/player/chordShapes.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/chords', `${n}.json`), 'utf8'));
let guitar = null, uke = null;
const shapes = () => (guitar ??= new ChordShapes(db('guitar')));
const frets = (p) => p.frets.map((f) => (f < 0 ? 'x' : f)).join('');

test('simbolo: ; fuera, bajo, transporte, sufijos de BTC, N sin acorde', () => {
  const a = parseSymbol('F#;7'), b = parseSymbol('Am7b5/G'), c = parseSymbol('C/E', 2), d = parseSymbol('Ehdim7'), e = parseSymbol('Bbmaj13');
  expect(a.root === 6 && a.quality === '7' && a.bass === -1, JSON.stringify(a));
  expect(b.root === 9 && b.quality === 'm7b5' && b.bass === 7, JSON.stringify(b));
  expect(c.root === 2 && c.bass === 6 && c.quality === 'major', JSON.stringify(c));
  expect(d.quality === 'm7b5' && e.root === 10 && e.quality === 'major', `${d.quality} ${JSON.stringify(e)}`);
  expect(parseSymbol('N') === null && parseSymbol('') === null && parseSymbol(null) === null && parseSymbol('C/C').bass === -1, 'N, vacio, bajo = raiz');
});

test('formas: exacta, sin bajo (rotulo Bajo), triada de lo desconocido', () => {
  const s = shapes();
  const exact = s.find(parseSymbol('C/E')), noBass = s.find(parseSymbol('Cmaj7/E')), triad = s.find(parseSymbol('Cmaj13'));
  expect(exact?.bassShown && noBass && !noBass.bassShown && triad?.bassShown, `C/E ${exact?.bassShown}, Cmaj7/E ${noBass?.bassShown}, Cmaj13 ${!!triad}`);
  expect(s.find(parseSymbol('N')) === null, 'N sin forma');
});

test('posicion: Abierta = C x32010 y F xx3211 (sin cejilla: mas facil); 7-12 dentro de la zona; Auto mueve poco la mano', () => {
  const s = shapes();
  const c = pickVoicing(s.find(parseSymbol('C')), 0, null), f = pickVoicing(s.find(parseSymbol('F')), 0, null);
  expect(frets(c) === 'x32010' && frets(f) === 'xx3211', `C ${frets(c)}, F ${frets(f)}`);
  const hi = pickVoicing(s.find(parseSymbol('C')), 2, null);
  expect(hi.handFret >= 7 && hi.handFret <= 12, `C en 7-12: traste ${hi.handFret}`);
  // Auto desde un acorde en el traste 8: el siguiente no salta a la cejuela
  const g = pickVoicing(s.find(parseSymbol('G')), ZONE_AUTO, hi);
  expect(Math.abs(g.handFret - hi.handFret) <= 3, `G tras traste ${hi.handFret}: traste ${g.handFret}`);
  return `C ${frets(c)}, F ${frets(f)}, C(7-12) traste ${hi.handFret}, G auto traste ${g.handFret}`;
});

test('ukelele: C abierto 0003', () => {
  uke ??= new ChordShapes(db('ukulele'));
  const c = pickVoicing(uke.find(parseSymbol('C')), 0, null);
  expect(frets(c) === '0003', frets(c));
});

test('piano: bajo abajo, novenas arriba, inversiones', () => {
  const k = (s) => pianoKeys(parseSymbol(s)).join(',');
  const got = { C: k('C'), 'C/E': k('C/E'), Am: k('Am'), C9: k('C9'), 'Am7/G': k('Am7/G') };
  expect(got.C === '0,4,7' && got['C/E'] === '4,7,12' && got.Am === '9,12,16' && got.C9 === '0,4,7,10,14' && got['Am7/G'] === '7,9,12,16', JSON.stringify(got));
  expect(noteName(10, true, true) === 'Sib' && noteName(1, false, false) === 'C#', 'nombres de nota');
});

test('linea de tiempo: sin repetidos, cambio por beat y Auto igual tras un seek', () => {
  const cells = ['C', null, 'C', 'G', null, 'Am', 'F', null].map((chord) => ({ chord }));
  const ch = chordChanges(cells);
  expect(ch.map((c) => `${c.beat}${c.raw}`).join() === '0C,3G,5Am,6F', ch.map((c) => `${c.beat}${c.raw}`).join());
  expect(changeAt(ch, 4) === 1 && changeAt(ch, 7) === 3 && changeAt([{ beat: 2 }], 1) === -1, 'cambio en beat');
  assignVoicings(ch, shapes(), ZONE_AUTO, 0);
  const a = ch.map((c) => frets(c.position)).join(' ');
  assignVoicings(ch, shapes(), ZONE_AUTO, 0);
  expect(ch.map((c) => frets(c.position)).join(' ') === a && ch.every((c) => c.position), `auto: ${a}`);
  return a;
});
