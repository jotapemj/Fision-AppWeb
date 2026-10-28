// Lector minimo de ZIP (stored + deflate) sobre DecompressionStream. Sin ZIP64.

export interface ZipEntry { name: string; method: number; compSize: number; size: number; headerOffset: number }

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export function listZip(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // EOCD: buscar hacia atras (comentario de hasta 64 KiB)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip_invalid');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64_unsupported');
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== CEN_SIG) throw new Error('zip_invalid');
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    out.push({
      method: dv.getUint16(p + 10, true),
      compSize: dv.getUint32(p + 20, true),
      size: dv.getUint32(p + 24, true),
      headerOffset: dv.getUint32(p + 42, true),
      name: dec.decode(buf.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export async function readZipEntry(buf: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const h = e.headerOffset;
  if (dv.getUint32(h, true) !== LOC_SIG) throw new Error('zip_invalid');
  const start = h + 30 + dv.getUint16(h + 26, true) + dv.getUint16(h + 28, true);
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error('zip_method_unsupported');
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  if (data.length !== e.size) throw new Error('zip_size_mismatch');
  return data;
}
