// Titulo, artista y portada embebidos en el audio (= MediaMetadataRetriever de ImportActivity).
// ID3v2 (mp3, aac, y dentro de wav/aiff), FLAC, Ogg Vorbis/Opus, MP4 (m4a) y RIFF/AIFF INFO.
// Se lee a trozos del Blob: un m4a de 200 MB no se carga entero. Lo que no se entiende = nada.

export interface AudioTags { title?: string; artist?: string; picture?: { mime: string; data: Uint8Array } }

type Read = (off: number, len: number) => Promise<Uint8Array>;

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);
const utf8 = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const le32 = (b: Uint8Array, o: number) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);
const syncsafe = (b: Uint8Array, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const clean = (s: string | undefined) => s?.replace(/\0+$/g, '').trim() || undefined;
const MAX_PIC = 8 << 20; // portadas absurdas fuera

export async function readTags(blob: Blob): Promise<AudioTags> {
  const read: Read = async (off, len) => new Uint8Array(await blob.slice(off, Math.min(blob.size, off + len)).arrayBuffer());
  try {
    const head = await read(0, 12);
    const magic = latin1(head.subarray(0, 4));
    if (magic === 'ID3\u0003' || magic === 'ID3\u0004' || latin1(head.subarray(0, 3)) === 'ID3') return await id3(read, 0);
    if (magic === 'fLaC') return await flac(read);
    if (magic === 'OggS') return await ogg(read);
    if (latin1(head.subarray(4, 8)) === 'ftyp') return await mp4(read, blob.size);
    if (magic === 'RIFF' && latin1(head.subarray(8, 12)) === 'WAVE') return await chunks(read, blob.size, false);
    if (magic === 'FORM' && /^AIF[FC]$/.test(latin1(head.subarray(8, 12)))) return await chunks(read, blob.size, true);
  } catch { /* fichero raro: sin etiquetas */ }
  return {};
}

// --- ID3v2.3 / 2.4 ---
function id3Text(b: Uint8Array): string | undefined {
  const enc = b[0], d = b.subarray(1);
  if (enc === 0) return clean(latin1(d));
  if (enc === 3) return clean(utf8(d));
  return clean(utf16(d, enc === 2));
}
function utf16(d: Uint8Array, be: boolean) {
  let o = 0;
  if (d[0] === 0xff && d[1] === 0xfe) { be = false; o = 2; } else if (d[0] === 0xfe && d[1] === 0xff) { be = true; o = 2; }
  return new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(d.subarray(o, o + ((d.length - o) & ~1)));
}
/** Salta un texto terminado en nulo (1 o 2 bytes segun codificacion). */
function skipZ(d: Uint8Array, o: number, wide: boolean) {
  if (!wide) { while (o < d.length && d[o] !== 0) o++; return o + 1; }
  while (o + 1 < d.length && (d[o] !== 0 || d[o + 1] !== 0)) o += 2;
  return o + 2;
}

async function id3(read: Read, at: number): Promise<AudioTags> {
  const h = await read(at, 10);
  const ver = h[3], size = syncsafe(h, 6);
  if (latin1(h.subarray(0, 3)) !== 'ID3' || (ver !== 3 && ver !== 4)) return {};
  const tag = await read(at + 10, size);
  let o = 0;
  if (h[5] & 0x40) o += ver === 4 ? syncsafe(tag, 0) : be32(tag, 0) + 4; // cabecera extendida
  const out: AudioTags = {};
  while (o + 10 <= tag.length) {
    const id = latin1(tag.subarray(o, o + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // relleno
    const len = ver === 4 ? syncsafe(tag, o + 4) : be32(tag, o + 4);
    const d = tag.subarray(o + 10, o + 10 + len);
    o += 10 + len;
    if (id === 'TIT2') out.title ??= id3Text(d);
    else if (id === 'TPE1') out.artist ??= id3Text(d);
    else if (id === 'APIC' && !out.picture && len < MAX_PIC) {
      const enc = d[0];
      let p = skipZ(d, 1, false);
      const mime = latin1(d.subarray(1, p - 1)) || 'image/jpeg';
      p = skipZ(d, p + 1, enc === 1 || enc === 2); // tipo + descripcion
      out.picture = { mime: mime.includes('/') ? mime : `image/${mime.toLowerCase()}`, data: d.slice(p) };
    }
  }
  return out;
}

// --- Vorbis comment (FLAC, Ogg) + bloque PICTURE ---
function vorbisComments(b: Uint8Array, out: AudioTags) {
  let o = 4 + le32(b, 0); // vendor
  const n = le32(b, o); o += 4;
  for (let i = 0; i < n && o + 4 <= b.length; i++) {
    const len = le32(b, o), s = utf8(b.subarray(o + 4, o + 4 + len)); o += 4 + len;
    const eq = s.indexOf('='), k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1);
    if (k === 'TITLE') out.title ??= clean(v);
    else if (k === 'ARTIST') out.artist ??= clean(v);
    else if (k === 'METADATA_BLOCK_PICTURE' && !out.picture && v.length < MAX_PIC * 1.4) {
      try { out.picture = flacPicture(Uint8Array.from(atob(v), (c) => c.charCodeAt(0))); } catch { /* base64 roto */ }
    }
  }
}
function flacPicture(b: Uint8Array) {
  let o = 4;
  const ml = be32(b, o), mime = latin1(b.subarray(o + 4, o + 4 + ml)); o += 4 + ml;
  o += 4 + be32(b, o) + 16; // descripcion + ancho, alto, profundidad, colores
  const dl = be32(b, o);
  return { mime: mime || 'image/jpeg', data: b.slice(o + 4, o + 4 + dl) };
}

async function flac(read: Read): Promise<AudioTags> {
  const out: AudioTags = {};
  for (let o = 4, last = false; !last;) {
    const h = await read(o, 4);
    if (h.length < 4) break;
    last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) vorbisComments(await read(o + 4, len), out);
    else if (type === 6 && !out.picture && len < MAX_PIC) out.picture = flacPicture(await read(o + 4, len));
    o += 4 + len;
  }
  return out;
}

/** Ogg: une los paquetes de las primeras paginas hasta tener el de comentarios (2o paquete). */
async function ogg(read: Read): Promise<AudioTags> {
  const packets: Uint8Array[] = [];
  let cur: number[] = [];
  for (let o = 0; packets.length < 2 && o < (16 << 20);) {
    const h = await read(o, 27);
    if (latin1(h.subarray(0, 4)) !== 'OggS') break;
    const segs = await read(o + 27, h[26]);
    let p = o + 27 + h[26];
    const body = await read(p, segs.reduce((a, s) => a + s, 0));
    let q = 0;
    for (const s of segs) {
      for (let i = 0; i < s; i++) cur.push(body[q + i]);
      q += s;
      if (s < 255) { packets.push(Uint8Array.from(cur)); cur = []; if (packets.length >= 2) break; }
    }
    p += body.length; o = p;
  }
  const c = packets[1], out: AudioTags = {};
  if (!c) return out;
  if (latin1(c.subarray(0, 7)) === '\u0003vorbis') vorbisComments(c.subarray(7), out);
  else if (latin1(c.subarray(0, 8)) === 'OpusTags') vorbisComments(c.subarray(8), out);
  return out;
}

// --- MP4: moov > udta > meta > ilst ---
async function mp4(read: Read, size: number): Promise<AudioTags> {
  /** Hijos [tipo, inicio de datos, fin] de una caja. */
  const kids = async (from: number, to: number) => {
    const out: [string, number, number][] = [];
    for (let o = from; o + 8 <= to;) {
      const h = await read(o, 16);
      let len = be32(h, 0), hdr = 8;
      if (len === 1) { len = be32(h, 8) * 2 ** 32 + be32(h, 12); hdr = 16; } else if (len === 0) len = to - o;
      if (len < hdr) break;
      out.push([latin1(h.subarray(4, 8)), o + hdr, o + len]);
      o += len;
    }
    return out;
  };
  const find = async (from: number, to: number, type: string) => (await kids(from, to)).find((k) => k[0] === type);
  const moov = await find(0, size, 'moov');
  const udta = moov && await find(moov[1], moov[2], 'udta');
  const meta = udta && await find(udta[1], udta[2], 'meta');
  const ilst = meta && await find(meta[1] + 4, meta[2], 'ilst'); // meta es "full box": 4 bytes de version
  const out: AudioTags = {};
  if (!ilst) return out;
  for (const [type, s, e] of await kids(ilst[1], ilst[2])) {
    if (type !== '©nam' && type !== '©ART' && type !== 'covr') continue;
    const data = await find(s, e, 'data');
    if (!data || data[2] - data[1] > MAX_PIC) continue;
    const d = await read(data[1], data[2] - data[1]);
    const kind = be32(d, 0) & 0xffffff, payload = d.subarray(8);
    if (type === 'covr') out.picture ??= { mime: kind === 14 ? 'image/png' : 'image/jpeg', data: payload.slice() };
    else if (type === '©nam') out.title ??= clean(utf8(payload));
    else out.artist ??= clean(utf8(payload));
  }
  return out;
}

// --- RIFF (WAV, LE) / FORM (AIFF, BE): INFO o NAME/AUTH, e ID3 embebido ---
async function chunks(read: Read, size: number, aiff: boolean): Promise<AudioTags> {
  const out: AudioTags = {};
  for (let o = 12; o + 8 <= size;) {
    const h = await read(o, 8);
    const id = latin1(h.subarray(0, 4)), len = aiff ? be32(h, 4) : le32(h, 4);
    const body = o + 8;
    if (id === 'id3 ' || id === 'ID3 ') {
      const t = await id3(read, body);
      out.title ??= t.title; out.artist ??= t.artist; out.picture ??= t.picture;
    } else if (!aiff && id === 'LIST' && len < 1 << 20) {
      const b = await read(body, len);
      if (latin1(b.subarray(0, 4)) === 'INFO') {
        for (let p = 4; p + 8 <= b.length;) {
          const k = latin1(b.subarray(p, p + 4)), n = le32(b, p + 4), v = clean(latin1(b.subarray(p + 8, p + 8 + n)));
          if (k === 'INAM') out.title ??= v; else if (k === 'IART') out.artist ??= v;
          p += 8 + n + (n & 1);
        }
      }
    } else if (aiff && (id === 'NAME' || id === 'AUTH') && len < 4096) {
      const v = clean(latin1(await read(body, len)));
      if (id === 'NAME') out.title ??= v; else out.artist ??= v;
    }
    o = body + len + (len & 1);
  }
  return out;
}
