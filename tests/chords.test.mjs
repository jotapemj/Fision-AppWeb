// Acordes: lectura, celdas por beat como Android, formato y acordes sobre la letra.
import { test, expect } from './lib/harness.mjs';
import { parseChords, buildBeatCells, currentBeat, soundingChord, nextChord, formatChord } from '../src/player/chords.ts';
import { buildRows, rowChords } from '../src/player/lyrics.ts';

const beats = Array.from({ length: 16 }, (_, i) => 0.5 + i * 0.5); // 120 BPM desde 0.5 s

test('lectura: N se salta, lineas rotas fuera', () => {
  const c = parseChords('N 0.000\nC 1.440\nbasura\nE;7 97.34\n');
  expect(c.map((x) => x.chord).join() === 'C,E;7' && c[0].time === 1.44, JSON.stringify(c));
});

test('celdas: 3/4 por moda de downbeats, posicion en el compas', () => {
  const db = [1.0, 2.5, 4.0, 5.5]; // cada 3 beats; empieza en el beat 1 (1.0 s)
  const { cells, beatsPerBar } = buildBeatCells(beats, db, []);
  expect(beatsPerBar === 3, `compas ${beatsPerBar}`);
  expect(cells.slice(0, 5).map((c) => c.pos).join() === '3,1,2,3,1', cells.slice(0, 5).map((c) => c.pos).join());
  expect(cells[1].isDownbeat && !cells[0].isDownbeat, 'downbeat');
  const none = buildBeatCells(beats, [], []);
  expect(none.beatsPerBar === 4 && none.cells[4].pos === 1, 'sin downbeats: 4/4 desde el primer beat');
});

test('cuantizacion al beat mas cercano; el ultimo gana; sin repetidos', () => {
  const ch = [{ chord: 'C', time: 0.7 }, { chord: 'G', time: 1.8 }, { chord: 'Am', time: 2.1 }, { chord: 'Am', time: 3.0 }];
  const { cells } = buildBeatCells(beats, [], ch);
  // 0.7 -> 0.5 (beat 0); 1.8 -> 2.0 (beat 3); 2.1 -> 2.0 (beat 3, gana Am); 3.0 -> beat 5, Am repetido -> null
  expect(cells[0].chord === 'C' && cells[3].chord === 'Am' && cells[5].chord === null, cells.map((c) => c.chord ?? '-').join(' '));
  expect(soundingChord(cells, 4) === 'Am' && nextChord(cells, 0) === 'Am', 'sonando / siguiente');
  expect(currentBeat(cells, 0.4) === -1 && currentBeat(cells, 1.74) === 2 && currentBeat(cells, 99) === 15, 'beat actual');
});

test('formato: transporte, bemoles, latino quita ;, bajo invertido', () => {
  expect(formatChord('C', 2) === 'D' && formatChord('A', 3) === 'C' && formatChord('B', 1) === 'C', 'transporte');
  expect(formatChord('C#m', 0, false, true) === 'Dbm', 'bemol');
  expect(formatChord('E;7', 0, true) === 'Mi7' && formatChord('E;7') === 'E;7', 'latino sin ;');
  expect(formatChord('C/G', -2) === 'A#/F', `invertido: ${formatChord('C/G', -2)}`);
  expect(formatChord('N.C.') === 'N.C.' && formatChord(null) === '', 'no parseable');
});

test('acordes sobre la letra = rebuildRowChords: fila encendida, letra que suena, hueco tras la palabra, instrumental', () => {
  const w = (s, e, t) => ({ start: s, end: e, text: t });
  const rows = buildRows({ segments: [
    { start: 2, end: 4, words: [w(2, 2.4, 'uno'), w(2.4, 3, 'dos'), w(3, 4, 'tres')] },
    { start: 20, end: 22, words: [w(20, 20.5, 'cuatro'), w(21.5, 22, 'cinco')] },
  ] }, 40);
  const marks = [[1.0, 'C'], [2.5, 'G'], [2.75, 'D'], [12, 'Am'], [21.0, 'F'], [21.4, 'E']].map(([time, raw]) => ({ time, raw }));
  const rc = rowChords(rows, marks);
  const t1 = rows.findIndex((r) => r.type === 'text'), ins = rows.findIndex((r) => r.type === 'instrumental'), t2 = rows.findLastIndex((r) => r.type === 'text');
  const fmt = (c) => `${c.raw}@${c.word}${c.after ? '+' : ''}:${c.char}`;
  const got = rc.map((cs, i) => `${i}[${cs.map(fmt).join(' ')}]`).join(' ');
  // Antes de la primera linea: su primera palabra; G y D sobre "dos" (letras 0 y 1: la palabra dura 0.6 s)
  expect(rc[t1].map(fmt).join(' ') === 'C@0:0 G@1:0 D@1:1', `linea 1: ${got}`);
  expect(rc[ins].map(fmt).join(' ') === 'Am@-1:0', `instrumental: ${got}`);
  // F en el silencio entre "cuatro" y "cinco": tras la palabra; E justo antes de "cinco": sobre ella
  expect(rc[t2].map(fmt).join(' ') === 'F@0+:0 E@1:0', `linea 2: ${got}`);
  // Sin marcas de palabra: palabras del texto repartidas por la linea
  const plain = buildRows({ segments: [{ start: 0, end: 4, text: 'a b c d' }] }, 4);
  const pc = rowChords(plain, [{ time: 2.1, raw: 'C' }]);
  expect(pc[0].length === 1 && pc[0][0].word === 2, `sin marcas: ${JSON.stringify(pc)}`);
  return got;
});

test('cuadricula: dos compases por fila, anacrusa en su sitio, compas irregular deja hueco', async () => {
  const { gridLayout } = await import('../src/ui/chordGrid.ts');
  const cell = (pos) => ({ time: 0, pos, isDownbeat: pos === 1, chord: null });
  // Anacrusa de 2 tiempos (3, 4), compas de 4, compas de 3 (irregular), compas de 4
  const cells = [3, 4, 1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 4].map(cell);
  const g = gridLayout(cells);
  expect(g.beatsPerBar === 4 && g.columns === 8, `bpb ${g.beatsPerBar}, columnas ${g.columns}`);
  expect(g.slotOf[0] === 2 && g.slotOf[2] === 4, `anacrusa ${g.slotOf.slice(0, 3)}`);
  expect(g.slotOf[9] === 12 && g.slots[11] === -1, `tras el compas de 3: ${g.slotOf[9]}, hueco ${g.slots[11]}`);
  const six = gridLayout([1, 2, 3, 4, 5, 6].map(cell));
  expect(six.columns === 6, 'compas de 6: un compas por fila');
});
