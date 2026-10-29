// UI de extremo a extremo: server falso + Vite + Chrome sin ventana. Se mide el pixel.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/harness.mjs';
import { findChrome, launch } from './lib/chrome.mjs';
import { makeZip, sineWav } from './lib/zipWriter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H1 = '1'.repeat(64), H2 = '2'.repeat(64), H3 = '3'.repeat(64);

// Server falso: cuenta "demo"/"pw"; H1 lista, H2 con error, H3 en cola
async function fakeServer() {
  const zip = makeZip([
    { name: 'vocals.wav', data: sineWav(440, 20) }, { name: 'bass.wav', data: sineWav(110, 20) },
    { name: 'kick.wav', data: sineWav(60, 20) }, { name: 'metronome.wav', data: sineWav(1000, 20) },
    { name: 'beats.txt', data: Buffer.from('120.0\n0.5\n1.0\n'), deflate: true },
  ]);
  const entry = (hash, title, state, created_at) => ({ hash, filename: `${title}.mp3`, title, artist: 'Prueba', cover_url: null, state, config: {}, created_at, updated_at: created_at });
  const srv = http.createServer(async (req, res) => {
    for await (const _ of req);
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/login') return json(200, { token: 'tok', user: 'demo', expires_at: '2099-01-01T00:00:00+00:00' });
    if (req.headers.authorization !== 'Bearer tok') return json(401, { detail: 'Not authenticated' });
    if (req.url === '/auth/refresh') return json(200, { token: 'tok', user: 'demo', expires_at: '2099-01-01T00:00:00+00:00' });
    if (req.url === '/library') return json(200, [entry(H1, 'Cancion buena', 'ready', '2026-10-03'), entry(H2, 'Cancion rota', 'error', '2026-10-02'), entry(H3, 'Cancion en cola', 'processing', '2026-10-01')]);
    if (req.url === '/jobs') return json(200, [{ job_id: 'j', hash: H3, filename: 'x', state: 'queued', position: 1 }]);
    if (req.url === `/library/${H1}/zip`) { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length }); return res.end(zip); }
    json(404, { detail: 'nope' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

// Medidas dentro de la pagina: solapes, recortes, contraste calculado
const MEASURE = `(() => {
  const parse = (c) => {
    let m = c.match(/rgba?\\(([^)]+)\\)/);
    if (m) { const v = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [v[0], v[1], v[2], v[3] ?? 1]; }
    m = c.match(/color\\(srgb ([^)]+)\\)/);
    if (m) { const v = m[1].split(/[ \\/]+/).filter(Boolean).map(Number); return [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1]; }
    return [0, 0, 0, 0];
  };
  const over = (top, bot) => [0, 1, 2].map((i) => top[i] * top[3] + bot[i] * (1 - top[3])).concat(1);
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3] > 0) stack.push(c); if (c[3] >= 1) break; }
    return stack.reverse().reduce((acc, c) => over(c, acc), [0, 0, 0, 1]);
  };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const out = { contrast: [], overlap: [], clipped: [], measured: 0, hscroll: document.documentElement.scrollWidth > innerWidth };
  const SEL = ['.dr .tx b', '.dr .tx span', '.bar2 .t', '.flt', '.stem .nm', '.stem .val', '.solo', '.group', '.act small', '.act b',
    '.seek .meta span', '.seg2 button', '.top .t b', '.top .t span', '.me .who span', '.me .out'];
  for (const s of SEL) for (const el of document.querySelectorAll(s)) {
    if (!el.getClientRects().length) continue;
    out.measured++;
    const st = getComputedStyle(el), fg = over(parse(st.color), bgOf(el));
    const r = ratio(fg, bgOf(el)), need = parseFloat(st.fontSize) >= 18.66 ? 3 : 4.5;
    if (r < need) out.contrast.push(s + ' ' + r.toFixed(2) + ' "' + el.textContent.trim().slice(0, 20) + '"');
  }
  const boxes = (sel) => [...document.querySelectorAll(sel)].map((e) => [sel + ':' + e.textContent.trim().slice(0, 12), e.getBoundingClientRect()]);
  const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  for (const group of [['.pbar > .seek', '.pbar > .btns', '.pbar > .acts'], ['.act'], ['.stem > *'], ['.seg2 button']]) {
    const bs = group.flatMap(boxes);
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      if (group[0] === '.stem > *' && bs[i][1].top !== bs[j][1].top) continue;
      if (hit(bs[i][1], bs[j][1])) out.overlap.push(bs[i][0] + ' x ' + bs[j][0]);
    }
  }
  for (const el of document.querySelectorAll('.act b, .act small, .seg2 button, .stem .nm, .seek .meta span')) {
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 0.5 || el.scrollWidth > el.clientWidth + 1) out.clipped.push(el.textContent.trim().slice(0, 20));
  }
  return out;
})()`;

let ctx = null; // un solo navegador para todo el fichero
async function setup() {
  if (ctx) return ctx;
  if (!findChrome()) return { skip: 'skip — falta Chrome (fija CHROME_PATH)' };
  if (!fs.existsSync(path.join(ROOT, 'public/engine/fision_engine.wasm'))) return { skip: 'skip — falta public/engine: compila con `npm run engine`' };
  const api = await fakeServer();
  process.env.FISION_SERVER = api.url;
  const { createServer } = await import('vite');
  const port = 5300 + Math.floor(Math.random() * 500);
  const vite = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'silent', server: { port, strictPort: true } });
  await vite.listen();
  const page = await launch();
  ctx = { page, url: `http://localhost:${port}/app/`, close: async () => { await page.close(); await vite.close(); api.close(); } };
  return ctx;
}

test('login, estados de la lista, descarga y apertura', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  try {
    await p.goto(c.url);
    await p.waitFor(`document.querySelector('.login form')`, 30000);
    await p.eval(`(()=>{const [u,w]=document.querySelectorAll('.login input');u.value='demo';w.value='pw';document.querySelector('.login form').requestSubmit();})()`);
    await p.waitFor(`document.querySelectorAll('.dr').length === 3`);
    const rows = await p.eval(`[...document.querySelectorAll('.dr')].map(r => [r.querySelector('b').textContent, !!r.querySelector('.spin'), !!r.querySelector('.bad'), r.classList.contains('cld')])`);
    expect(rows[0][0] === 'Cancion en cola' && rows[0][1], `en cola arriba con spinner: ${JSON.stringify(rows[0])}`);
    expect(rows.find((r) => r[0] === 'Cancion rota')[2], 'error marcado');
    const good = `[...document.querySelectorAll('.dr')].find(r => r.textContent.includes('Cancion buena'))`;
    expect(await p.eval(`${good}.classList.contains('cld')`), 'buena empieza en la nube');
    await p.eval(`${good}.click()`);
    await p.waitFor(`!${good}.classList.contains('cld')`, 20000);
    await p.eval(`${good}.click()`);
    await p.waitFor(`document.querySelectorAll('.stem').length === 3`, 20000);
    const names = await p.eval(`[...document.querySelectorAll('.stem .nm')].map(e => e.textContent).join()`);
    const tempo = await p.eval(`[...document.querySelectorAll('.act b')].map(b => b.textContent).join(' / ')`);
    expect(tempo.includes('120 BPM'), `BPM de beats.txt: ${tempo}`);
    return `stems: ${names}; ajustes: ${tempo}`;
  } catch (e) { await c.close(); ctx = { skip: 'skip — fallo previo' }; throw e; }
});

test('suena: la posicion avanza', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const t0 = await c.page.eval(`document.querySelector('.seek .meta span').textContent`);
  await new Promise((r) => setTimeout(r, 2500));
  const t1 = await c.page.eval(`document.querySelector('.seek .meta span').textContent`);
  expect(t1 !== t0 && t1 !== '00:00', `posicion ${t0} -> ${t1}`);
  return `${t0} -> ${t1}`;
});

for (const [w, hgt] of [[1440, 900], [1280, 800]]) {
  test(`sin solapes, recortes ni contraste bajo a ${w}x${hgt}`, async () => {
    const c = await setup(); if (c.skip) return c.skip;
    await c.page.size(w, hgt);
    await new Promise((r) => setTimeout(r, 300));
    const m = await c.page.eval(MEASURE);
    const acts = await c.page.eval(`document.querySelectorAll('.act').length`), stems = await c.page.eval(`document.querySelectorAll('.stem').length`);
    expect(acts === 3 && stems === 3 && m.measured > 30, `nada que medir: ${acts} ajustes, ${stems} stems, ${m.measured} textos (¿no se abrio la cancion?)`);
    expect(!m.hscroll, 'scroll horizontal en la pagina');
    expect(!m.overlap.length, `solapes: ${m.overlap.join('; ')}`);
    expect(!m.clipped.length, `recortados: ${m.clipped.join('; ')}`);
    expect(!m.contrast.length, `contraste < minimo: ${m.contrast.join('; ')}`);
    return `${m.measured} textos medidos`;
  });
}

test('sin excepciones en la pagina', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const errs = [...c.page.errors];
  await c.close(); ctx = { skip: 'skip — cerrado' };
  expect(!errs.length, errs.join(' | '));
});
