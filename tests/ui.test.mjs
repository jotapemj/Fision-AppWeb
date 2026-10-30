// UI de extremo a extremo: server falso + Vite + Chrome sin ventana. Se mide el pixel.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/harness.mjs';
import { findChrome, launch } from './lib/chrome.mjs';
import { makeZip, sineWav, bandsPng } from './lib/zipWriter.mjs';
import { decodePng } from './lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H1 = '1'.repeat(64), H2 = '2'.repeat(64), H3 = '3'.repeat(64);

const wd = (start, end, text) => ({ start, end, text });
const LYRICS = { language: 'es', segments: [
  { start: 0.5, end: 2, text: 'primera linea', words: [wd(0.5, 1, 'primera'), wd(1, 2, 'linea')] },
  { start: 2.5, end: 4, text: 'segunda linea', words: [wd(2.5, 3, 'segunda'), wd(3, 4, 'linea')] },
  { start: 12, end: 15, text: 'tercera tras pausa', words: [wd(12, 12.5, 'tercera'), wd(12.5, 13, 'tras'), wd(13, 15, 'pausa')] },
] };

// Server falso: cuenta "demo"/"pw"; H1 lista, H2 con error, H3 en cola
async function fakeServer() {
  const zip = makeZip([
    { name: 'vocals.wav', data: sineWav(440, 20) }, { name: 'bass.wav', data: sineWav(110, 20) },
    { name: 'kick.wav', data: sineWav(60, 20) }, { name: 'metronome.wav', data: sineWav(1000, 20) },
    // 120 BPM: un beat cada 0.5 s, compas de 4 (downbeat cada 2 s)
    { name: 'beats.txt', data: Buffer.from(['120.0', ...Array.from({ length: 40 }, (_, i) => (0.5 + i * 0.5).toFixed(2))].join('\n')), deflate: true },
    { name: 'downbeats.txt', data: Buffer.from(Array.from({ length: 10 }, (_, i) => (0.5 + i * 2).toFixed(2)).join('\n')) },
    { name: 'chords.txt', data: Buffer.from('N 0.000\nC 0.500\nG 2.500\nAm 12.000\n') },
    // Portada magenta y azul: con colores de la cancion, el acento pasa a ser rojizo
    { name: 'artcover.png', data: bandsPng(64, 64, [[[200, 30, 120], 0.6], [[30, 40, 160], 0.4]]) },
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
    if (req.url === `/library/${H1}/lyrics`) return json(200, LYRICS);
    if (req.url === `/library/${H1}/zip`) {
      // Lento a proposito: 5 trozos cada 300 ms, para ver la ola de descarga
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length });
      const n = 5, step = Math.ceil(zip.length / n);
      for (let i = 0; i < n; i++) { res.write(zip.subarray(i * step, (i + 1) * step)); await new Promise((r) => setTimeout(r, 300)); }
      return res.end();
    }
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
  const out = { contrast: [], overlap: [], clipped: [], measured: 0, hscroll: document.documentElement.scrollWidth > innerWidth, vscroll: document.documentElement.scrollHeight > innerHeight };
  const SEL = ['.fxpanel b', '.fxv', '.lr small', '.fxpanel .seg button', '.dr .tx b', '.dr .tx span', '.bar2 .t', '.flt', '.stem .nm', '.stem .val', '.solo', '.group', '.act small', '.act b',
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
  for (const group of [['.pbar > .seek', '.btns > *', '.act'], ['.stem > *'], ['.seg2 button'], ['.mixwrap > .mix', '.fxpanel'], ['.fxpanel .seg button']]) {
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
    // Ola sobre la portada mientras baja: canvas con pixeles pintados
    await p.waitFor(`${good}.querySelector('canvas.wave')`, 5000);
    await new Promise((r) => setTimeout(r, 400));
    const wave = await p.eval(`(() => { const c = ${good}.querySelector('canvas.wave'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n / (d.length / 4); })()`);
    expect(wave > 0.9, `ola sin pintar: ${(wave * 100).toFixed(0)} %`);
    await p.waitFor(`!${good}.classList.contains('cld')`, 20000);
    expect(!(await p.eval(`!!${good}.querySelector('canvas.wave')`)), 'la ola sigue tras descargar');
    await p.eval(`${good}.click()`);
    // Telon: canvas opaco con el nucleo blanco en el centro; luego se va
    await p.waitFor(`document.querySelector('canvas.curtain-c')`, 3000);
    await new Promise((r) => setTimeout(r, 300));
    const cur = await p.eval(`(() => { const c = document.querySelector('canvas.curtain-c'); const x = c.getContext('2d'); const W = c.width, H = c.height;
      const px = (fx, fy) => x.getImageData(Math.round(W * fx), Math.round(H * fy), 1, 1).data;
      const corner = px(0.05, 0.05); let white = 0; const R = 34 * devicePixelRatio;
      for (let a = 0; a < 64; a++) { const d = x.getImageData(Math.round(W / 2 + Math.cos(a / 64 * 2 * Math.PI) * R * 0.85), Math.round(H / 2 + Math.sin(a / 64 * 2 * Math.PI) * R * 0.85), 1, 1).data; if (d[0] > 200 && d[3] > 200) white++; }
      return { cornerA: corner[3], white }; })()`);
    expect(cur.cornerA === 255 && cur.white >= 3, `telon: alpha esquina ${cur.cornerA}, puntos blancos del arco ${cur.white}`);
    await p.waitFor(`!document.querySelector('canvas.curtain-c')`, 8000);
    await p.waitFor(`document.querySelectorAll('.stem').length === 3`, 20000);
    const names = await p.eval(`[...document.querySelectorAll('.stem .nm')].map(e => e.textContent).join()`);
    const tempo = await p.eval(`[...document.querySelectorAll('.act b')].map(b => b.textContent).join(' / ')`);
    expect(tempo.includes('120 BPM'), `BPM de beats.txt: ${tempo}`);
    return `ola ${(wave * 100).toFixed(0)} % pintada, telon con arco (${cur.white}/64), stems: ${names}; ajustes: ${tempo}`;
  } catch (e) { await c.close(); ctx = { skip: 'skip — fallo previo' }; throw e; }
});

test('metronomo: encender y elegir 2x desde su desplegable', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  const metro = `[...document.querySelectorAll('.act')].find(b => b.querySelector('small').textContent === 'Metronome' || b.querySelector('small').textContent === 'Metrónomo')`;
  const before = await p.eval(`${metro}.querySelector('b').textContent`);
  await p.eval(`${metro}.click()`);
  await p.waitFor(`document.querySelector('.pop .switch')`);
  await p.eval(`document.querySelector('.pop .switch').click()`);
  await p.eval(`[...document.querySelectorAll('.pop .seg button')].find(b => b.textContent === '2×').click()`);
  const after = await p.eval(`${metro}.querySelector('b').textContent`);
  const abHidden = await p.eval(`document.querySelectorAll('.pop .seg')[1].hidden`);
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  expect(after === '2×' && before !== after && abHidden, `antes ${before}, despues ${after}, A/B oculto ${abHidden}`);
  return `${before} -> ${after}`;
});

test('letra: la linea activa sigue a la cancion y tocar una linea hace seek', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  await p.eval(`document.querySelectorAll('.seg2 button')[0].click()`);
  await p.waitFor(`document.querySelectorAll('.lyrics .cl').length >= 4`, 10000);
  const kinds = await p.eval(`[...document.querySelectorAll('.lyrics .cl')].map(e => e.classList.contains('ins') ? 'i' : 't').join('')`);
  expect(kinds === 'ttit', `filas (texto/instrumental): ${kinds}`);
  // Seek a la tercera linea tocandola
  await p.eval(`document.querySelectorAll('.lyrics .cl')[3].click()`);
  await p.waitFor(`document.querySelectorAll('.lyrics .cl')[3].classList.contains('now')`, 5000);
  const pos = await p.eval(`document.querySelector('.seek .meta span').textContent`);
  const nNow = await p.eval(`document.querySelectorAll('.lyrics .cl.now').length`);
  expect(pos === '00:12' && nNow === 1, `tras tocar: posicion ${pos}, activas ${nNow}`);
  // La pagina no crece con la letra: el transporte sigue dentro de la ventana
  const lay = await p.eval(`({ doc: document.documentElement.scrollHeight, vh: innerHeight, bar: document.querySelector('.pbar').getBoundingClientRect().bottom, scroller: document.querySelector('.lyrics').scrollHeight > document.querySelector('.lyrics').clientHeight })`);
  expect(lay.doc <= lay.vh && Math.round(lay.bar) <= lay.vh && lay.scroller, `pagina ${lay.doc}px en ventana ${lay.vh}px, transporte acaba en ${Math.round(lay.bar)}px, letra con scroll propio: ${lay.scroller}`);
  await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`); // volver a Mezcla para las medidas
  return `filas ${kinds}, seek a ${pos}`;
});

test('acordes: tira por beat, ahora/luego y acorde sobre la palabra', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  await p.eval(`document.querySelectorAll('.seg2 button')[1].click()`);
  await p.waitFor(`document.querySelectorAll('.strip .c').length === 40`, 5000);
  const bars = await p.eval(`document.querySelectorAll('.strip .bar').length`);
  await p.eval(`document.querySelectorAll('.strip .c')[24].click()`); // 12.5 s, suena Am
  await p.waitFor(`document.querySelector('.strip .c.now') === document.querySelectorAll('.strip .c')[24]`, 5000);
  const nowNext = await p.eval(`[...document.querySelectorAll('.now-ch b')].map(b => b.textContent).join(' / ')`);
  expect(bars === 9 && nowNext === 'Am / –', `barras ${bars}, ahora/luego ${nowNext}`);
  // En la letra, G (2.5 s) cae sobre "segunda" (2.5-3.0)
  await p.eval(`document.querySelectorAll('.seg2 button')[0].click()`);
  const over = await p.eval(`[...document.querySelectorAll('.lyrics .wd')].filter(w => w.querySelector('.ch')?.textContent).map(w => w.querySelector('.ch').textContent + '>' + w.lastChild.textContent).join(' ')`);
  expect(over.includes('G>segunda') && over.includes('C>primera'), `acordes sobre palabras: ${over}`);
  await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`);
  return `ahora/luego ${nowNext}; ${over}`;
});

test('fondo animado: apagado por defecto; encendido pinta color y no tapa clics', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  const state = `(() => { const n = document.querySelector('canvas.nebula'); const d = n.getContext('2d').getImageData(0, 0, n.width, n.height).data;
    let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++;
    return { op: +getComputedStyle(n).opacity, lit: lit / (d.length / 4), top: document.elementFromPoint(innerWidth - 200, innerHeight / 2)?.tagName }; })()`;
  const off = await p.eval(state);
  expect(off.op === 0, `apagado por defecto: opacidad ${off.op}`);
  await p.eval(`document.querySelector('.top .ib').click()`);
  await p.waitFor(`document.querySelector('.menu-pop .switch')`);
  await p.eval(`document.querySelector('.menu-pop .switch').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const on = await p.eval(state);
  await p.eval(`document.querySelector('.menu-pop .switch').click()`); // dejarlo como estaba
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  expect(on.op === 1 && on.lit > 0.2, `encendido: opacidad ${on.op}, pixeles con color ${(on.lit * 100).toFixed(0)} %`);
  expect(on.top !== 'CANVAS', `el canvas tapa la UI: ${on.top}`);
  return `encendido: ${(on.lit * 100).toFixed(0)} % de pixeles con color`;
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
    expect(acts === 4 && stems === 3 && m.measured > 30, `nada que medir: ${acts} ajustes, ${stems} stems, ${m.measured} textos (¿no se abrio la cancion?)`);
    expect(!m.hscroll && !m.vscroll, `scroll en la pagina: horizontal ${m.hscroll}, vertical ${m.vscroll}`);
    expect(!m.overlap.length, `solapes: ${m.overlap.join('; ')}`);
    expect(!m.clipped.length, `recortados: ${m.clipped.join('; ')}`);
    expect(!m.contrast.length, `contraste < minimo: ${m.contrast.join('; ')}`);
    return `${m.measured} textos medidos`;
  });
}

test('ajustes: dialogo medible, cifrado latino y colores de portada', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  await p.eval(`document.querySelectorAll('.seg2 button')[1].click()`); // vista Acordes
  await p.eval(`document.querySelector('.me .gear').click()`);
  await p.waitFor(`document.querySelector('dialog.settings[open]')`);
  const box = await p.eval(`(() => { const d = document.querySelector('dialog.settings').getBoundingClientRect(); return [d.top >= 0, d.bottom <= innerHeight, d.right <= innerWidth]; })()`);
  expect(box.every(Boolean), `dialogo fuera de la ventana: ${box}`);
  // Solapes de filas y contraste dentro del dialogo
  const bad = await p.eval(`(() => { const out = []; for (const r of document.querySelectorAll('dialog.settings .srow')) {
      const kids = [...r.children].map(k => k.getBoundingClientRect());
      const [x, y] = kids; if (kids.length === 2 && x.left < y.right - 0.5 && y.left < x.right - 0.5 && x.top < y.bottom - 0.5 && y.top < x.bottom - 0.5) out.push(r.textContent.slice(0, 30)); } return out; })()`);
  expect(!bad.length, `filas con solape: ${bad.join(' | ')}`);
  const clipped = await p.eval(`(() => { const d = document.querySelector('dialog.settings').getBoundingClientRect(); const out = [];
    for (const el of document.querySelectorAll('dialog.settings .seg, dialog.settings .seg button, dialog.settings .srow > *')) {
      const r = el.getBoundingClientRect();
      if (el.scrollWidth > el.clientWidth + 1 || r.right > d.right + 0.5) out.push(el.textContent.trim().slice(0, 24)); } return out; })()`);
  expect(!clipped.length, `recortado en ajustes: ${clipped.join(' | ')}`);
  const latin = `[...document.querySelectorAll('dialog.settings .seg button')].find(b => /Latin|Latino/.test(b.textContent))`;
  await p.eval(`${latin}.click()`);
  await p.waitFor(`[...document.querySelectorAll('.strip .c')].some(e => e.textContent === 'Lam')`, 3000);
  await p.eval(`[...document.querySelectorAll('dialog.settings .seg button')].find(b => /American|Americano/.test(b.textContent)).click()`);
  const root = await p.eval(`getComputedStyle(document.querySelector('.main')).getPropertyValue('--accent').trim()`);
  const songSw = `[...document.querySelectorAll('dialog.settings .srow')].find(r => /cover|portada|canción|song/i.test(r.textContent)).querySelector('.switch')`;
  await p.eval(`${songSw}.click()`);
  await p.waitFor(`getComputedStyle(document.querySelector('.main')).getPropertyValue('--accent').trim() !== ${JSON.stringify(root)}`, 5000);
  const song = await p.eval(`getComputedStyle(document.querySelector('.main')).getPropertyValue('--accent').trim()`);
  const side = await p.eval(`getComputedStyle(document.querySelector('.pane')).getPropertyValue('--accent').trim()`);
  await p.eval(`${songSw}.click()`); // dejarlo apagado
  await p.waitFor(`getComputedStyle(document.querySelector('.main')).getPropertyValue('--accent').trim() === ${JSON.stringify(root)}`, 3000);
  await p.eval(`document.querySelector('dialog.settings').close()`);
  await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`);
  expect(/^rgb/.test(song) && side === root, `acento cancion ${song}, lateral ${side} (debe seguir ${root})`);
  return `acento ${root} -> ${song} (lateral sin cambio)`;
});

test('FX: el nombre abre el panel; el filtro se aplica, se rotula y se quita', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  await p.eval(`[...document.querySelectorAll('.stem .nm')].find(b => /Voz|Vocals/.test(b.textContent)).click()`);
  await p.waitFor(`/Voz|Vocals/.test(document.querySelector('.fxtop b')?.textContent)`, 3000);
  await p.eval(`(() => { const r = document.querySelector('.fxpanel input[aria-label="Filtro"], .fxpanel input[aria-label="Filter"]'); r.value = '-60'; r.dispatchEvent(new Event('input')); })()`);
  const label = await p.eval(`document.querySelectorAll('.fxpanel .fxv')[1].textContent`);
  const marked = await p.eval(`document.querySelector('.stem.sel').classList.contains('fx')`);
  await p.eval(`document.querySelector('.fxpanel .btn.ghost').click()`); // Quitar FX
  const cleared = await p.eval(`!document.querySelector('.stem.fx')`);
  expect(/(Paso bajo|Low-pass|Low pass).*Hz/i.test(label) && marked && cleared, `rotulo "${label}", fila marcada ${marked}, quitar FX ${cleared}`);
  return label;
});

test('la mezcla de la cancion sobrevive a recargar la pagina', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  const bass = `[...document.querySelectorAll('.stem')].find(r => r.querySelector('.nm').textContent === 'Bajo' || r.querySelector('.nm').textContent === 'Bass')`;
  await p.eval(`(() => { const r = ${bass}.querySelector('input'); r.value = '40'; r.dispatchEvent(new Event('input')); })()`);
  await new Promise((r) => setTimeout(r, 700)); // guardado diferido 400 ms
  await p.goto(c.url);
  await p.waitFor(`document.querySelectorAll('.dr').length === 3`, 20000);
  await p.eval(`[...document.querySelectorAll('.dr')].find(r => r.textContent.includes('Cancion buena')).click()`);
  await p.waitFor(`document.querySelectorAll('.stem').length === 3`, 20000);
  const v = await p.eval(`${bass}.querySelector('.val').textContent`);
  expect(v === '40', `bajo tras recargar: ${v}`);
  return `bajo = ${v} tras recargar`;
});

test('3D: escena pintada, luces con el interruptor, arrastre, omni, mute, baile y reset', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  await p.eval(`[...document.querySelectorAll('.seg2 button')][3].click()`);
  await p.waitFor(`document.querySelector('.d3 canvas') && !document.querySelector('.d3 .d3load')`, 20000);
  await new Promise((r) => setTimeout(r, 300));
  // Brillo medio de la escena en una captura (WebGL no se lee desde la pagina)
  const shotLum = async () => {
    const r = await p.eval(`(() => { const b = document.querySelector('.d3').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    const png = decodePng(Buffer.from((await p.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } })).result.data, 'base64'));
    let sum = 0, lit = 0;
    for (let i = 0; i < png.data.length; i += 4) { const l = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; sum += l; if (l > 12) lit++; }
    return { mean: sum / (png.data.length / 4), lit: lit / (png.data.length / 4) };
  };
  const off = await shotLum();
  const sc = `document.querySelector('.d3').scene3d`;
  await p.eval(`document.querySelector('.d3head .switch').click()`);
  await new Promise((r) => setTimeout(r, 500));
  const on = await shotLum();
  expect(on.lit > 0.6 && on.mean > off.mean * 1.5, `escena: con 3D ${(on.lit * 100).toFixed(0)} % pintado, brillo ${on.mean.toFixed(1)} frente a ${off.mean.toFixed(1)} apagado`);
  expect(await p.eval(`document.querySelectorAll('.seg2 button')[3].classList.contains('on3d')`), 'pestana 3D sin marca de encendido');
  const stem = await p.eval(`[...${sc}.sprites.keys()][0]`);
  const mouse = async (type, x, y, extra = {}) => p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  // Arrastre: 120 px a la derecha de la pantalla
  let s0 = await p.eval(`${sc}.probe('${stem}')`);
  await mouse('mousePressed', s0.x, s0.y);
  for (let k = 1; k <= 6; k++) await mouse('mouseMoved', s0.x + k * 20, s0.y);
  await mouse('mouseReleased', s0.x + 120, s0.y);
  const s1 = await p.eval(`${sc}.probe('${stem}')`);
  expect(s1.pose.placed && Math.abs(s1.x - (s0.x + 120)) < 12 && Math.abs(s1.pose.az - s0.pose.az) > 0.05, `arrastre: pantalla ${s0.x.toFixed(0)} -> ${s1.x.toFixed(0)}, az ${s0.pose.az.toFixed(2)} -> ${s1.pose.az.toFixed(2)}`);
  expect(!(await p.eval(`document.querySelector('.d3btns .d3btn:last-child').hidden`)), 'reset oculto tras mover');
  // Doble clic = omnipresente
  for (let k = 0; k < 2; k++) { await mouse('mousePressed', s1.x, s1.y); await mouse('mouseReleased', s1.x, s1.y); }
  const omni = (await p.eval(`${sc}.probe('${stem}')`)).pose.omni;
  // Pulsacion larga = mute 3D
  await mouse('mousePressed', s1.x, s1.y); await new Promise((r) => setTimeout(r, 650)); await mouse('mouseReleased', s1.x, s1.y);
  const muted = (await p.eval(`${sc}.probe('${stem}')`)).pose.muted;
  expect(omni && muted, `omni ${omni}, mute ${muted}`);
  // Baile: dialogo, iniciar, gira, parar
  await p.eval(`document.querySelector('.d3btns .d3btn').click()`);
  await p.waitFor(`document.querySelector('dialog.dance')`, 3000);
  await p.eval(`document.querySelector('dialog.dance .btn').click()`);
  const a0 = (await p.eval(`${sc}.probe('${stem}')`)).pose.az;
  await new Promise((r) => setTimeout(r, 600));
  const d = await p.eval(`${sc}.probe('${stem}')`);
  const panel = await p.eval(`!document.querySelector('.d3panel').hidden`);
  expect(d.dancing && panel && Math.abs(d.pose.az - a0) > 0.05, `baile: activo ${d.dancing}, panel ${panel}, giro ${(d.pose.az - a0).toFixed(3)} rad`);
  await p.eval(`document.querySelector('.d3btns .d3btn').click()`);
  // Reset: todo al semicirculo, sin omni ni mute
  await p.eval(`document.querySelector('.d3btns .d3btn:last-child').click()`);
  await new Promise((r) => setTimeout(r, 1300));
  const after = await p.eval(`[...${sc}.sprites.keys()].map((k) => ${sc}.probe(k).pose)`);
  expect(after.every((q) => !q.placed && !q.omni && !q.muted && q.rh === 1.5 && q.h === 0), `reset: ${JSON.stringify(after)}`);
  // Mezcla bloqueada con el 3D encendido
  await p.eval(`[...document.querySelectorAll('.seg2 button')][2].click()`);
  const locked = await p.eval(`!!document.querySelector('.note3d') && [...document.querySelectorAll('.stem input')].every((i) => i.disabled)`);
  await p.eval(`[...document.querySelectorAll('.seg2 button')][3].click()`);
  await p.eval(`document.querySelector('.d3head .switch').click()`); // deja el 3D como estaba
  expect(locked, 'mezcla sin bloquear en 3D');
  return `pintado ${(on.lit * 100).toFixed(0)} %, brillo ${off.mean.toFixed(0)} -> ${on.mean.toFixed(0)}, arrastre, omni, mute, baile, reset y mezcla bloqueada`;
});

test('sin excepciones en la pagina', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const errs = [...c.page.errors];
  await c.close(); ctx = { skip: 'skip — cerrado' };
  expect(!errs.length, errs.join(' | '));
});
