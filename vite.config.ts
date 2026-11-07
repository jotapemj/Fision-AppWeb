import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Server real para el proxy de desarrollo (mismo origen que en produccion)
const SERVER = process.env.FISION_SERVER ?? 'http://localhost:8000';
const API = ['/login', '/auth', '/health', '/jobs', '/library', '/playlists', '/server'];
const proxy = Object.fromEntries(API.map((p) => [p, { target: SERVER, changeOrigin: true }]));

// SharedArrayBuffer (hilos WASM) exige aislamiento de origen
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// PWA: tras el build escribe sw.js con todos los ficheros de la salida y una version = hash del contenido
function pwa(): Plugin {
  let out = 'dist';
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  return {
    name: 'fision-pwa',
    apply: 'build',
    configResolved(c) { out = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      const files = walk(out).map((f) => path.relative(out, f).split(path.sep).join('/')).filter((f) => f !== 'sw.js').sort();
      const h = createHash('sha256');
      for (const f of files) h.update(f).update(fs.readFileSync(path.join(out, f)));
      // Escena 3D (busto 6 MB + chunk de three.js): no se precarga; se guarda al usarla
      const lazy = files.filter((f) => f.startsWith('models/') || /^assets\/scene3d-.*\.js$/.test(f));
      const list = ['', ...files.filter((f) => f !== 'index.html' && !lazy.includes(f))]; // la pagina se guarda como '' (la URL /app/)
      const src = fs.readFileSync(path.resolve(import.meta.dirname, 'src/pwa/sw.template.js'), 'utf8')
        .replace("'__VERSION__'", JSON.stringify(h.digest('hex').slice(0, 12)))
        .replace('__FILES__', JSON.stringify(list))
        .replace('__LAZY__', JSON.stringify(lazy));
      fs.writeFileSync(path.join(out, 'sw.js'), src);
    },
  };
}

export default defineConfig({
  base: '/app/', // el server sirve la web en /app
  plugins: [pwa()],
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: ['.ts.net'], // movil por tailscale serve
    headers: isolation,
    proxy,
  },
  preview: { port: 4173, allowedHosts: ['.ts.net'], headers: isolation, proxy },
  build: { target: 'es2022' },
});
