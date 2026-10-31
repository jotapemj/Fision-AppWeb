// Etiquetas embebidas: ficheros minimos de cada formato montados aqui.
import { test, expect } from './lib/harness.mjs';
import { readTags } from '../src/lib/audioTags.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const cat = (...b) => Buffer.concat(b.map((x) => (typeof x === 'string' ? Buffer.from(x, 'latin1') : Buffer.from(x))));
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const syncsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const tags = (buf) => readTags(new Blob([buf]));

function id3(ver, frames) {
  const body = cat(...frames.map(([id, d]) => cat(id, ver === 4 ? syncsafe(d.length) : u32be(d.length), [0, 0], d)), Buffer.alloc(16));
  return cat('ID3', [ver, 0, 0], syncsafe(body.length), body);
}
const utf16bom = (s) => cat([0xff, 0xfe], Buffer.from(s, 'utf16le'));

test('mp3 ID3v2.3: latin1, UTF-16 con BOM y APIC', async () => {
  const f = id3(3, [['TIT2', cat([0], 'Cancion')], ['TPE1', cat([1], utf16bom('Señora Ñ'))],
    ['APIC', cat([0], 'image/png', [0], [3], 'desc', [0], PNG)]]);
  const t = await tags(cat(f, Buffer.alloc(100)));
  expect(t.title === 'Cancion' && t.artist === 'Señora Ñ', JSON.stringify(t));
  expect(t.picture?.mime === 'image/png' && Buffer.from(t.picture.data).equals(PNG), 'portada');
});

test('mp3 ID3v2.4: UTF-8 y tamanos syncsafe', async () => {
  const t = await tags(id3(4, [['TIT2', cat([3], Buffer.from('Canción', 'utf8'))], ['TPE1', cat([3], Buffer.from('Artista', 'utf8'))]]));
  expect(t.title === 'Canción' && t.artist === 'Artista' && !t.picture, JSON.stringify(t));
});

const vorbis = (pairs) => cat(u32le(3), 'abc', u32le(pairs.length), ...pairs.map((s) => { const b = Buffer.from(s, 'utf8'); return cat(u32le(b.length), b); }));
const flacPic = () => cat(u32be(3), u32be(9), 'image/png', u32be(0), u32be(1), u32be(1), u32be(24), u32be(0), u32be(PNG.length), PNG);

test('flac: comentarios Vorbis y bloque PICTURE', async () => {
  const vc = vorbis(['title=Título', 'ARTIST=Grupo']), pic = flacPic();
  const block = (type, last, d) => cat([(last ? 0x80 : 0) | type, (d.length >> 16) & 255, (d.length >> 8) & 255, d.length & 255], d);
  const t = await tags(cat('fLaC', block(0, false, Buffer.alloc(34)), block(4, false, vc), block(6, true, pic), Buffer.alloc(50)));
  expect(t.title === 'Título' && t.artist === 'Grupo' && t.picture?.mime === 'image/png' && Buffer.from(t.picture.data).equals(PNG), JSON.stringify({ ...t, picture: t.picture?.mime }));
});

test('ogg opus: OpusTags repartido entre paginas, portada en base64', async () => {
  const head = cat('OpusHead', Buffer.alloc(11));
  const comments = cat('OpusTags', vorbis(['TITLE=Larga', 'ARTIST=X', `METADATA_BLOCK_PICTURE=${flacPic().toString('base64')}`, `PAD=${'z'.repeat(400)}`]));
  // Paginas: 1a = cabecera; el comentario (>255) se parte en dos paginas
  const page = (segs, body) => cat('OggS', Buffer.alloc(22), [segs.length], segs, body);
  const lacing = (n) => { const s = []; while (n >= 255) { s.push(255); n -= 255; } s.push(n); return s; };
  const l = lacing(comments.length), cut = 2 * 255;
  const t = await tags(cat(page([head.length], head), page(l.slice(0, 2), comments.subarray(0, cut)), page(l.slice(2), comments.subarray(cut))));
  expect(t.title === 'Larga' && t.artist === 'X' && t.picture && Buffer.from(t.picture.data).equals(PNG), JSON.stringify({ ...t, picture: !!t.picture }));
});

test('m4a: moov > udta > meta > ilst (©nam, ©ART, covr)', async () => {
  const box = (type, ...kids) => { const b = cat(...kids); return cat(u32be(8 + b.length), type, b); };
  const data = (kind, payload) => box('data', u32be(kind), u32be(0), payload);
  const ilst = box('ilst', box('©nam', data(1, Buffer.from('Tema', 'utf8'))), box('©ART', data(1, Buffer.from('Autora', 'utf8'))), box('covr', data(14, PNG)));
  const f = cat(box('ftyp', 'M4A ', u32be(0)), box('mdat', Buffer.alloc(300)), box('moov', box('mvhd', Buffer.alloc(20)), box('udta', box('meta', u32be(0), box('hdlr', Buffer.alloc(25)), ilst))));
  const t = await tags(f);
  expect(t.title === 'Tema' && t.artist === 'Autora' && t.picture?.mime === 'image/png', JSON.stringify({ ...t, picture: t.picture?.mime }));
});

test('wav: LIST INFO; aiff: NAME/AUTH; desconocido = nada', async () => {
  const info = cat('INFO', 'INAM', u32le(5), 'Nota', [0, 0], 'IART', u32le(3), 'Yo', [0, 0]);
  const wav = cat('RIFF', u32le(0), 'WAVE', 'fmt ', u32le(16), Buffer.alloc(16), 'LIST', u32le(info.length), info, 'data', u32le(4), Buffer.alloc(4));
  const w = await tags(wav);
  expect(w.title === 'Nota' && w.artist === 'Yo', `wav ${JSON.stringify(w)}`);
  const aif = cat('FORM', u32be(0), 'AIFF', 'NAME', u32be(4), 'Aire', 'AUTH', u32be(3), 'Ana', [0]);
  const a = await tags(aif);
  expect(a.title === 'Aire' && a.artist === 'Ana', `aiff ${JSON.stringify(a)}`);
  const none = await tags(Buffer.from('basura sin formato'));
  expect(!none.title && !none.picture, 'desconocido');
  const cut = await tags(id3(3, [['TIT2', cat([0], 'x')]]).subarray(0, 12));
  expect(!cut.title, 'cortado no rompe');
});
