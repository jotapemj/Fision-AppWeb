// Letra: saneado, filas instrumentales, onset de la 1a palabra, relevo y karaoke.
import { test, expect, near } from './lib/harness.mjs';
import { buildRows, activeRow, switchAt, firstWordOnset, wordProgress, sanitize } from '../src/player/lyrics.ts';

const w = (start, end, text) => ({ start, end, text });
const json = { segments: [
  { start: 10, end: 14, text: 'Hola mundo', words: [w(10, 12.5, 'Hola'), w(12.5, 14, 'mundo')] }, // "Hola" se come 2.5 s
  { start: 14, end: 17, text: 'otra linea', words: [w(14, 15, 'otra'), w(15, 17, 'linea')] },
  { start: 30, end: 33, text: 'tras el solo', words: [w(30, 30.4, 'tras'), w(30.4, 31, 'el'), w(31, 33, 'solo')] },
] };

test('saneado: fuera nulos y tiempos no finitos', () => {
  const s = sanitize({ segments: [null, { start: 'x', end: 1 }, { start: 1, end: 2, words: [null, w(1, NaN, 'a'), w(1, 2, ' b ')] }] });
  expect(s.segments.length === 1 && s.segments[0].words.length === 1 && s.segments[0].words[0].text === 'b', JSON.stringify(s));
  expect(sanitize('basura').segments.length === 0, 'json roto');
});

test('filas: instrumental si el hueco es de 8 s o mas', () => {
  const rows = buildRows(json, 50);
  expect(rows.map((r) => r.type[0]).join('') === 'ittiti', rows.map((r) => `${r.type}@${r.start}`).join(' '));
  // 0-10 (10 s) si; 17-30 (13 s) si; 33-50 (17 s) si
});

test('onset de la 1a palabra: corrige el silencio que se come Whisper', () => {
  near(firstWordOnset(w(10, 12.5, 'Hola')), 12.5 - (0.25 + 0.07 * 4), 1e-9, 'larga');
  expect(firstWordOnset(w(30, 30.4, 'tras')) === 30, 'corta: se respeta');
});

test('relevo: no antes del fin de la anterior ni pasado su onset', () => {
  const rows = buildRows(json, 50);
  const t1 = rows.findIndex((r) => r.text === 'Hola mundo');
  near(switchAt(rows, t1), rows[t1].onset - 0.15, 1e-9, 'primera: onset - 150 ms');
  const sw = switchAt(rows, t1 + 1), nx = rows[t1 + 1];
  expect(sw >= rows[t1].end && sw <= nx.onset, `siguiente: ${sw} fuera de [${rows[t1].end}, ${nx.onset}]`);
  // Anterior que acaba despues de onset-150 ms: manda el fin de la anterior
  const tight = buildRows({ segments: [{ start: 5.5, end: 5.95, words: [w(5.5, 5.95, 'a')] }, { start: 6, end: 6.2, words: [w(6, 6.2, 'b')] }] }, 7);
  near(switchAt(tight, 1), 5.95, 1e-9, 'fin de la anterior');
  expect(activeRow(rows, 5) === 0, 'instrumental inicial activa');
  expect(activeRow(rows, rows[t1].onset - 0.2) === -1 || activeRow(rows, rows[t1].onset - 0.2) === 0, 'antes del relevo');
  expect(activeRow(rows, 13) === t1, 'Hola mundo');
  expect(activeRow(rows, 16) === t1 + 1, 'otra linea');
  expect(activeRow(rows, 20) === t1 + 2, 'pausa larga = fila instrumental');
  expect(activeRow(rows, 49) === rows.length - 1, 'instrumental final');
  expect(activeRow(rows, 51) === -1, 'pasado el final');
});

test('karaoke: cada palabra funde en 250 ms desde su onset', () => {
  const rows = buildRows(json, 50);
  const first = rows.find((r) => r.text === 'Hola mundo').words[0];
  expect(wordProgress(first, first.onset - 0.01) === 0, 'antes');
  near(wordProgress(first, first.onset + 0.125), 0.5, 1e-9, 'mitad');
  expect(wordProgress(first, first.onset + 1) === 1, 'despues');
});
