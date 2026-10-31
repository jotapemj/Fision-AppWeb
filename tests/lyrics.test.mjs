// Letra: saneado, filas instrumentales, onset de la 1a palabra, relevo y karaoke.
import { test, expect, near } from './lib/harness.mjs';
import { buildRows, activeRow, switchAt, firstWordOnset, wordProgress, sanitize } from '../src/player/lyrics.ts';
import { VocalActivity } from '../src/player/vocalActivity.ts';

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
  const seg = (x) => ({ start: x.start, end: x.end, text: x.text, words: [x] });
  near(firstWordOnset(seg(w(10, 12.5, 'Hola'))), 12.5 - (0.25 + 0.07 * 4), 1e-9, 'larga');
  expect(firstWordOnset(seg(w(30, 30.4, 'tras'))) === 30, 'corta: se respeta');
});

test('frases fusionadas: parte en inicios comunes, respeta nombres propios', () => {
  const words = (s, t0) => s.split(' ').map((x, i) => w(t0 + i * 0.5, t0 + i * 0.5 + 0.5, x));
  const seg = (s, t0) => { const ws = words(s, t0); return { start: t0, end: ws.at(-1).end, text: s, words: ws }; };
  const rows = buildRows({ segments: [
    seg('estar en pie Porque ya hasta', 1),
    seg('vamos al Campo de Pepín', 5),
    seg('Todavía no, Pero sí', 9),
    seg('la gente dice que nada', 13),
  ] }, 20).filter((r) => r.type === 'text').map((r) => r.text);
  expect(JSON.stringify(rows) === JSON.stringify(['estar en pie', 'Porque ya hasta', 'vamos al Campo de Pepín', 'Todavía no, Pero sí', 'la gente dice que nada']), JSON.stringify(rows));
  const split = buildRows({ segments: [seg('estar en pie Porque ya', 1)] }, 0);
  near(split[1].start, 2.5, 1e-9, 'la parte nueva empieza en su palabra');
  near(split[0].end, 2.5, 1e-9, 'la primera acaba en su ultima palabra');
});

// Envolvente sintetica: -10 dBFS donde hay voz, -90 en silencio (frames de 10 ms)
const envelope = (sec, voiced) => {
  const e = new Float32Array(Math.round(sec * 100)).fill(-90);
  for (const [a, b] of voiced) e.fill(-10, Math.round(a * 100), Math.round(b * 100));
  return e;
};

test('voz medida: onsets, fin de la voz y hueco instrumental de 4 s', () => {
  const env = envelope(25, [[12, 13.3], [14, 15.2], [20, 21]]);
  const va = VocalActivity.fromEnvelopes(env, null);
  const js = { segments: [
    { start: 10, end: 15, text: 'Y vuelvo aqui', words: [w(10, 12.5, 'Y'), w(12.5, 13.5, 'vuelvo'), w(13.5, 15, 'aqui')] },
    { start: 20, end: 21, text: 'fin', words: [w(20, 21, 'fin')] },
  ] };
  const rows = buildRows(js, 25, va), r = rows.find((x) => x.text === 'Y vuelvo aqui');
  near(r.onset, 12, 0.011, '1a palabra: regreso de la voz');
  near(r.words[1].onset, 12.5, 1e-9, 'voz continua: se respeta');
  near(r.words[2].onset, 13.96, 0.02, 'tras la pausa: fin del valle - 50 ms');
  near(r.voicedEnd, 15.2, 0.011, 'nota sostenida mas alla del end');
  // Con medida bastan 4 s: 15.2-20.5 y 21-25 son instrumentales; sin ella hacen falta 8
  expect(rows.map((x) => x.type[0]).join('') === 'ititi', `con medida: ${rows.map((x) => x.type[0]).join('')}`);
  const plain = buildRows(js, 25);
  expect(plain.map((x) => x.type[0]).join('') === 'itt', `sin medida: ${plain.map((x) => x.type[0]).join('')}`);
  expect(plain.find((x) => x.text === 'Y vuelvo aqui').voicedEnd === 15, 'sin medida: end');
  // Relevo: el verso siguiente no toma el relevo antes de que acabe la voz
  const i = rows.indexOf(r);
  expect(switchAt(rows, i + 1) >= 15.2 - 1e-9, 'relevo tras voicedEnd');
  expect(VocalActivity.fromEnvelopes(new Float32Array(100).fill(-95)) === null, 'sin voz audible = null');
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
