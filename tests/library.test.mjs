// Estado de filas, orden, busqueda y filtro de la biblioteca.
import { test, expect } from './lib/harness.mjs';
import { buildRows, search, applyFilter, counts, deleteKind } from '../src/library/library.ts';

const e = (hash, title, artist, created_at, state = 'ready') => ({ hash, title, artist, created_at, state, filename: '', cover_url: null, updated_at: created_at });
const entries = [
  e('a', 'Nasío pa la Alegría', 'Estopa', '2026-10-01'),
  e('b', 'Airplane Mode', 'Josh Woodward', '2026-10-03'),
  e('c', 'El Pozo', 'IZAL', '2026-10-02'),
  e('d', 'Ciega, Sordomuda', 'Shakira', '2026-09-01', 'error'),
];

test('estados: descargando > job vivo > descargada > nube/error', () => {
  const rows = buildRows({ entries, downloaded: new Set(['b', 'c']), downloading: new Map([['a', 42]]),
    jobs: [{ job_id: 'j', hash: 'c', filename: '', state: 'queued', position: 2 }] });
  const st = Object.fromEntries(rows.map((r) => [r.entry.hash, r.state]));
  expect(st.a.kind === 'downloading' && st.a.pct === 42, JSON.stringify(st.a));
  expect(st.c.kind === 'queued' && st.c.position === 2, JSON.stringify(st.c));
  expect(st.b.kind === 'downloaded' && st.d.kind === 'error', `${st.b.kind} ${st.d.kind}`);
  expect(rows.map((r) => r.entry.hash).join() === 'c,b,a,d', `orden ${rows.map((r) => r.entry.hash)}`);
});

test('busqueda sin tildes ni mayusculas, por titulo y artista', () => {
  const rows = buildRows({ entries, downloaded: new Set(), downloading: new Map(), jobs: [] });
  expect(search(rows, 'alegria').length === 1, 'tilde');
  expect(search(rows, 'IZAL').map((r) => r.entry.hash).join() === 'c', 'artista');
  expect(search(rows, '  ').length === 4, 'vacio = todo');
});

test('filtro y cuando se muestra', () => {
  const none = buildRows({ entries, downloaded: new Set(), downloading: new Map(), jobs: [] });
  expect(!counts(none).showFilter, 'sin descargadas no hay filtro');
  const rows = buildRows({ entries, downloaded: new Set(['b']), downloading: new Map([['a', 5]]), jobs: [] });
  const c = counts(rows);
  expect(c.showFilter && c.downloaded === 1 && c.cloud === 2, JSON.stringify(c));
  expect(applyFilter(rows, 'cloud').map((r) => r.entry.hash).sort().join() === 'a,c', 'nube incluye descargando');
});

test('borrar segun estado (showBottomDialog): cola, copia, nube; procesando o bajando no', () => {
  const k = (kind) => deleteKind({ kind });
  const got = ['queued', 'downloaded', 'cloud', 'error', 'running', 'waiting_gpu', 'downloading'].map(k).join();
  expect(got === 'queue,local,cloud,cloud,,,', got);
});
