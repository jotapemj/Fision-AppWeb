// Chrome sin ventana hablado por CDP (sin dependencias). CHROME_PATH fija el ejecutable.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

export const findChrome = () => CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lanza Chrome con un perfil temporal propio; close() lo mata y borra el perfil. */
export async function launch({ width = 1440, height = 900 } = {}) {
  const exe = findChrome();
  if (!exe) throw new Error('falta Chrome (fija CHROME_PATH)');
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'fision-ui-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    `--window-size=${width},${height}`, '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let tabs;
  for (let i = 0; i < 50 && !tabs; i++) { await wait(100); tabs = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => null); }
  if (!tabs) { proc.kill(); throw new Error('Chrome no abre el puerto de depuracion'); }
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let n = 0;
  const pend = new Map(), errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? 'excepcion');
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  const page = {
    errors,
    send,
    async size(w, h) { await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); },
    async goto(url) { await send('Page.navigate', { url }); },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(`eval: ${r.result.exceptionDetails.exception?.description ?? expr}`);
      return r.result?.result?.value;
    },
    async waitFor(expr, ms = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (await page.eval(`!!(${expr})`)) return; await wait(100); }
      throw new Error(`tiempo agotado esperando: ${expr}`);
    },
    async close() {
      try { ws.close(); } catch {}
      const gone = new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
      proc.kill();
      await Promise.race([gone, wait(5000)]);
      // Windows suelta los ficheros del perfil un poco despues de morir el proceso
      fs.rmSync(prof, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    },
  };
  await page.size(width, height);
  return page;
}
