// Canciones descargadas en OPFS, como SongStorage de Android:
//   acc_<usuario>/<hash>/   ficheros del result.zip ya descomprimidos
//   acc_<usuario>/<hash>/.complete   {updated_at} — se escribe al final
// Sin .complete la carpeta no cuenta (descarga cortada) y se borra al guardar.

/** Subconjunto de FileSystemDirectoryHandle que se usa (los tests lo imitan). */
export interface DirHandle {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
}
export interface FileHandle {
  getFile(): Promise<Blob>;
  createWritable(): Promise<{ write(d: Uint8Array | string): Promise<void>; close(): Promise<void> }>;
}

export interface StoredFile { name: string; data: Uint8Array }

const MARK = '.complete';
const HASH_RE = /^[0-9a-f]{64}$/;
// Nombres planos: sin rutas (control zip-slip, como Android)
const safeName = (n: string) => n.length > 0 && !/[\\/]/.test(n) && n !== '.' && n !== '..' && n !== MARK;

const notFound = (e: unknown) => (e as { name?: string })?.name === 'NotFoundError';

export class SongStore {
  private root: Promise<DirHandle>;

  constructor(user: string, rootDir: () => Promise<DirHandle> = () => navigator.storage.getDirectory() as unknown as Promise<DirHandle>) {
    this.root = rootDir().then((r) => r.getDirectoryHandle(`acc_${encodeURIComponent(user)}`, { create: true }));
  }

  /** updated_at de la copia local, o null si no hay copia completa. */
  async version(hash: string): Promise<string | null> {
    try {
      const d = await (await this.root).getDirectoryHandle(hash);
      const f = await (await d.getFileHandle(MARK)).getFile();
      return JSON.parse(await f.text()).updated_at ?? null;
    } catch (e) { if (notFound(e)) return null; throw e; }
  }

  /** updated_at con el que se refrescaron los acordes (al descargar = el de la copia). */
  async chordsStamp(hash: string): Promise<string | null> {
    const m = await this.mark(hash);
    return m ? (m.chords_at ?? m.updated_at ?? null) : null;
  }

  async setChordsStamp(hash: string, stamp: string): Promise<void> {
    const m = await this.mark(hash);
    if (!m) return; // borrada mientras tanto
    await writeFile(await (await this.root).getDirectoryHandle(hash), MARK, JSON.stringify({ ...m, chords_at: stamp }));
  }

  private async mark(hash: string): Promise<{ updated_at?: string; chords_at?: string } | null> {
    try {
      const d = await (await this.root).getDirectoryHandle(hash);
      return JSON.parse(await (await (await d.getFileHandle(MARK)).getFile()).text());
    } catch (e) { if (notFound(e)) return null; throw e; }
  }

  /** Hashes con copia completa. */
  async list(): Promise<string[]> {
    const out: string[] = [];
    for await (const name of (await this.root).keys()) {
      if (HASH_RE.test(name) && (await this.version(name)) !== null) out.push(name);
    }
    return out;
  }

  async save(hash: string, updatedAt: string, files: StoredFile[]): Promise<void> {
    if (!HASH_RE.test(hash)) throw new Error('bad_hash');
    const bad = files.find((f) => !safeName(f.name));
    if (bad) throw new Error('bad_entry_name');
    await this.remove(hash);
    const d = await (await this.root).getDirectoryHandle(hash, { create: true });
    for (const f of files) await writeFile(d, f.name, f.data);
    await writeFile(d, MARK, JSON.stringify({ updated_at: updatedAt }));
  }

  /** Ficheros de una copia completa (filtro opcional por nombre). */
  async load(hash: string, want: (name: string) => boolean = () => true): Promise<StoredFile[]> {
    if ((await this.version(hash)) === null) throw new Error('not_downloaded');
    const d = await (await this.root).getDirectoryHandle(hash);
    const out: StoredFile[] = [];
    for await (const name of d.keys()) {
      if (name === MARK || !want(name)) continue;
      const blob = await (await d.getFileHandle(name)).getFile();
      out.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Sustituye (o borra con null) un fichero de una copia completa: p. ej. lyrics.json al refrescar. */
  async putFile(hash: string, name: string, data: Uint8Array | null): Promise<void> {
    if (!safeName(name)) throw new Error('bad_entry_name');
    if ((await this.version(hash)) === null) throw new Error('not_downloaded');
    const d = await (await this.root).getDirectoryHandle(hash);
    if (data) await writeFile(d, name, data);
    else try { await d.removeEntry(name); } catch (e) { if (!notFound(e)) throw e; }
  }

  async remove(hash: string): Promise<void> {
    try { await (await this.root).removeEntry(hash, { recursive: true }); } catch (e) { if (!notFound(e)) throw e; }
  }
}

async function writeFile(d: DirHandle, name: string, data: Uint8Array | string) {
  const w = await (await d.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}
