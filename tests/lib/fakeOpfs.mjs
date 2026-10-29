// Imitacion minima de OPFS (FileSystemDirectoryHandle) sobre una carpeta real.
import fs from 'node:fs';
import path from 'node:path';

const nf = (p) => new DOMException(`no existe: ${p}`, 'NotFoundError');

export function dirHandle(dir) {
  return {
    async getDirectoryHandle(name, { create = false } = {}) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) { if (!create) throw nf(p); fs.mkdirSync(p); }
      return dirHandle(p);
    },
    async getFileHandle(name, { create = false } = {}) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) { if (!create) throw nf(p); fs.writeFileSync(p, ''); }
      return {
        getFile: async () => new Blob([fs.readFileSync(p)]),
        createWritable: async () => {
          const parts = [];
          return { write: async (d) => { parts.push(Buffer.from(d)); }, close: async () => fs.writeFileSync(p, Buffer.concat(parts)) };
        },
      };
    },
    async removeEntry(name, { recursive = false } = {}) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) throw nf(p);
      fs.rmSync(p, { recursive });
    },
    async *keys() { for (const n of fs.readdirSync(dir)) yield n; },
  };
}
