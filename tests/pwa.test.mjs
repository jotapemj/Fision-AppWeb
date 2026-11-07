// PWA: build real + vite preview + Chrome sin ventana. Instalable, app en cache (escena 3D al usarla) y arranque sin red.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/harness.mjs';
import { findChrome, launch } from './lib/chrome.mjs';
import { decodePng } from './lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('instalable, guarda la app (la escena 3D al usarla) y arranca sin red', async () => {
  if (!findChrome()) return 'skip — falta Chrome (fija CHROME_PATH)';
  if (!fs.existsSync(path.join(ROOT, 'public/engine/fision_engine.wasm'))) return 'skip — falta public/engine: compila con `npm run engine`';
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fision-pwa-'));
  process.env.FISION_SERVER = 'http://127.0.0.1:9'; // sin server: basta la pantalla de login
  const { build, preview } = await import('vite');
  const cfg = { root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } };
  await build(cfg);
  const port = 5800 + Math.floor(Math.random() * 400);
  const srv = await preview({ ...cfg, preview: { port, strictPort: true } });
  const p = await launch({ width: 412, height: 915 });
  try {
    const url = `http://localhost:${port}/app/`;
    // Manifest e iconos: tamanos reales y la version maskable a sangre (sin transparencia en la esquina)
    const man = JSON.parse(fs.readFileSync(path.join(out, 'manifest.webmanifest'), 'utf8'));
    expect(man.start_url === '/app/' && man.scope === '/app/' && man.display === 'standalone', `manifest: ${JSON.stringify(man)}`);
    for (const ic of man.icons) {
      const png = decodePng(fs.readFileSync(path.join(out, ic.src)));
      expect(`${png.width}x${png.height}` === ic.sizes, `${ic.src}: ${png.width}x${png.height} frente a ${ic.sizes}`);
      const cornerA = png.data[3];
      expect(ic.purpose === 'maskable' ? cornerA === 255 : cornerA === 0, `${ic.src}: alfa de la esquina ${cornerA}`);
    }
    await p.goto(url);
    await p.waitFor(`document.querySelector('.login form')`, 30000);
    // El service worker se instala con todo y toma la pagina
    const ready = await p.eval(`Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 15000))])`);
    expect(ready, 'el service worker no se activa');
    if (!(await p.eval(`!!navigator.serviceWorker.controller`))) { await p.goto(url); await p.waitFor(`navigator.serviceWorker.controller`, 15000); }
    const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
    const files = JSON.parse(sw.match(/const FILES = (\[.*\]);/)[1]);
    const cached = await p.eval(`caches.keys().then(async (ks) => { const c = await caches.open(ks.find(k => k.startsWith('fision-app-'))); return (await c.keys()).map(r => new URL(r.url).pathname); })`);
    expect(cached.length === files.length, `en cache ${cached.length} de ${files.length}`);
    for (const need of ['/app/', '/app/engine/fision_engine.wasm', '/app/hrtf/hrtf_horizontal.bin', '/app/chords/guitar.json'])
      expect(cached.includes(need), `falta en cache: ${need}`);
    // La escena 3D (busto de 6 MB y su chunk con three.js) no se baja al instalar: solo al usarla, y entonces queda guardada
    const lazy = JSON.parse(sw.match(/const LAZY = (\[.*\]);/)?.[1] ?? '[]');
    expect(lazy.includes('models/head.glb') && lazy.some((f) => /^assets\/scene3d-.*\.js$/.test(f)), `fuera de la precarga: ${lazy}`);
    expect(!cached.some((f) => f.endsWith('head.glb') || /scene3d-/.test(f)), 'la escena 3D se precarga');
    const mb = files.reduce((a, f) => a + (f ? fs.statSync(path.join(out, f)).size : 0), 0) / 2 ** 20;
    expect(mb < 6.5, `precarga ${mb.toFixed(1)} MB`);
    await p.eval(`fetch('/app/models/head.glb').then((r) => r.arrayBuffer()).then(() => 0)`);
    // El guardado sigue tras la respuesta (waitUntil): esperar a que aparezca
    const stored = await p.waitFor(`caches.keys().then(async (ks) => { const c = await caches.open(ks.find(k => k.startsWith('fision-app-'))); return !!(await c.match('/app/models/head.glb')); })`, 5000).then(() => true, () => false);
    expect(stored, 'head.glb no se guarda al usarlo');
    const inst = await p.send('Page.getInstallabilityErrors');
    const errs = inst.result?.installabilityErrors ?? [];
    expect(!errs.length, `no instalable: ${JSON.stringify(errs)}`);
    // Sin red: la app sale igual (y aislada: el motor necesita SharedArrayBuffer)
    await p.send('Network.enable');
    await p.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await p.goto(url);
    await p.waitFor(`document.querySelector('.login form')`, 15000);
    const iso = await p.eval(`crossOriginIsolated`);
    expect(iso, 'sin red, la pagina de la cache no esta aislada (COOP/COEP)');
    return `${files.length} ficheros (${mb.toFixed(1)} MB) en cache, 3D al usarla, instalable, arranca sin red aislada`;
  } finally {
    await p.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    await p.close();
    await new Promise((r) => srv.httpServer.close(r));
    fs.rmSync(out, { recursive: true, force: true });
  }
});
