// Playlists sin red: validacion, errores por code, que se puede anadir, mosaico y orden prev/next.
import { test, expect } from './lib/harness.mjs';
import { validate, errorKey, pickable, mosaicHashes, playlistRows, adjacent, move, isValidId } from '../src/library/playlists.ts';

const row = (hash, kind) => ({ entry: { hash, title: hash }, state: { kind } });

test('validacion antes de enviar y textos por code (nunca el detail)', () => {
  const v = [validate('  ', []), validate('x'.repeat(101), []), validate('ok', ['a', 'a']), validate('ok', Array.from({ length: 2001 }, (_, i) => `h${i}`)), validate(' Ensayo ', ['a', 'b'])];
  expect(v.join() === 'title_empty,title_length,song_duplicate,song_limit,', v.join());
  const k = [errorKey(0, 'network'), errorKey(404, 'http_404'), errorKey(400, 'title_length'), errorKey(400, 'playlist_limit'), errorKey(413, 'http_413', true), errorKey(500, 'internal')];
  expect(JSON.stringify(k) === JSON.stringify([['playlist_err_network'], ['playlist_err_gone'], ['playlist_err_title_length', 100], ['playlist_err_playlist_limit', 200], ['playlist_err_cover_too_large'], ['playlist_err_generic', 500]]), JSON.stringify(k));
  expect(isValidId('a1b2c3d4e5f6') && !isValidId('../etc/passwd') && !isValidId('A1B2C3D4E5F6'), 'id');
});

test('se anaden las de la nube; mosaico de 4 o la primera; filas en orden sin las borradas', () => {
  const rows = [row('a', 'downloaded'), row('b', 'cloud'), row('c', 'downloading'), row('d', 'queued'), row('e', 'error')];
  expect(pickable(rows).map((r) => r.entry.hash).join('') === 'abc', 'pickable');
  expect(mosaicHashes(['a', 'b', 'c', 'd', 'e']).join('') === 'abcd' && mosaicHashes(['a', 'b']).join('') === 'a' && mosaicHashes([]).length === 0, 'mosaico');
  expect(playlistRows({ songs: ['c', 'zz', 'a'] }, rows).map((r) => r.entry.hash).join('') === 'ca', 'filas');
});

test('prev/next: orden de la playlist (solo descargadas) si suena desde ella; si no, la biblioteca', () => {
  const lib = [row('a', 'downloaded'), row('b', 'cloud'), row('c', 'downloaded'), row('d', 'downloaded')];
  const q = ['d', 'b', 'a'];
  expect(adjacent('d', 1, lib, q) === 'a' && adjacent('a', -1, lib, q) === 'd' && adjacent('a', 1, lib, q) === null, 'playlist');
  expect(adjacent('a', 1, lib, null) === 'c' && adjacent('c', 1, lib, ['d', 'a']) === 'd', 'biblioteca (c no esta en la cola)');
  expect(move(['a', 'b', 'c', 'd'], 0, 2).join('') === 'bcad' && move(['a', 'b', 'c'], 2, 0).join('') === 'cab', 'mover');
});
