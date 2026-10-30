// UI de extremo a extremo: server falso + Vite + Chrome sin ventana. Se mide el pixel.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/harness.mjs';
import { findChrome, launch } from './lib/chrome.mjs';
import { makeZip, sineWav, bandsPng } from './lib/zipWriter.mjs';
import { decodePng } from './lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H1 = '1'.repeat(64), H2 = '2'.repeat(64), H3 = '3'.repeat(64), H4 = '4'.repeat(64);

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
  const pl = { list: [], calls: [] }; // playlists en memoria
  const del = { calls: [], queueGone: false, gone: false, busy: true }; // borrados
  const up = { jobs: null, calls: [], zips: [], newReady: false, config: {}, lyr: { posts: [], polls: 0, ready: false } }; // subidas, reprocesos, letra
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/login') return json(200, { token: 'tok', user: 'demo', expires_at: '2099-01-01T00:00:00+00:00' });
    if (req.headers.authorization !== 'Bearer tok') return json(401, { detail: 'Not authenticated' });
    if (req.url === '/auth/refresh') return json(200, { token: 'tok', user: 'demo', expires_at: '2099-01-01T00:00:00+00:00' });
    if (req.method === 'DELETE' && req.url === '/jobs/j') { del.calls.push('DELETE /jobs/j'); del.queueGone = true; return json(200, { job_id: 'j', state: 'cancelled' }); }
    if (req.method === 'DELETE' && req.url === `/library/${H2}`) {
      del.calls.push(`DELETE H2${del.busy ? ' 409' : ''}`);
      if (del.busy) { del.busy = false; return json(409, { detail: 'busy', code: 'job_running' }); }
      del.gone = true; return json(200, { hash: H2, deleted: true });
    }
    if (req.url === '/library') {
      const lib = [entry(H1, 'Cancion buena', 'ready', '2026-10-03'), entry(H2, 'Cancion rota', 'error', '2026-10-02'), entry(H3, 'Cancion en cola', del.queueGone ? 'cancelled' : 'processing', '2026-10-01')]
        .filter((x) => !(del.gone && x.hash === H2));
      if (up.newReady !== false) lib.push({ ...entry(H4, 'Subida', up.newReady === true ? 'ready' : 'processing', '2026-10-04'), config: up.config });
      return json(200, lib);
    }
    if (req.url === '/jobs' && req.method === 'GET') {
      // Un job subido se ve en vuelo una vez y luego acaba
      const extra = up.jobs ? [up.jobs] : [];
      if (up.jobs) { up.jobs = null; up.newReady = 'pending'; }
      else if (up.newReady === 'pending') up.newReady = true;
      if (up.lyr.posts.length && !up.lyr.ready) extra.push({ job_id: 'jl', hash: H4, filename: 'x', state: 'running', position: 0 });
      return json(200, [...(del.queueGone ? [] : [{ job_id: 'j', hash: H3, filename: 'x', state: 'queued', position: 1 }]), ...extra]);
    }
    if (req.url === '/server/info') return json(200, { version: '2.1.0', gpu: false });
    if (req.url === '/jobs' && req.method === 'POST') {
      const cfg = (body.match(/name="config_json"\r\n\r\n([^\r]*)/) || [])[1];
      up.calls.push({ type: req.headers['content-type'], cfg, name: (body.match(/filename="([^"]+)"/) || [])[1] });
      up.config = JSON.parse(cfg || '{}');
      up.jobs = { job_id: 'jnew', hash: H4, filename: 'x', state: 'queued', position: 2 };
      return json(200, { hash: H4, job_id: 'jnew', state: 'queued', cached: false });
    }
    if (req.url === `/library/${H1}/reprocess`) { up.calls.push({ reprocess: decodeURIComponent(body.replace(/\+/g, ' ')) }); return json(200, { hash: H1, job_id: 'jr', state: 'queued' }); }
    if (req.url.startsWith('/jobs/') && req.url !== '/jobs/jl') return json(200, { job_id: req.url.slice(6), hash: req.url.includes('jr') ? H1 : H4, state: 'done', position: null, error: '', error_code: '' });
    if (req.url === `/library/${H1}/lyrics`) return json(200, LYRICS);
    if (req.url === `/library/${H4}/lyrics` && req.method === 'POST') { up.lyr.posts.push(body); return json(200, { hash: H4, job_id: 'jl', state: 'queued' }); }
    if (req.url === `/library/${H4}/lyrics`) return up.lyr.ready ? json(200, LYRICS) : json(404, { detail: 'No lyrics', code: 'lyrics_missing' });
    if (req.url === '/jobs/jl') { if (++up.lyr.polls >= 2) up.lyr.ready = true; return json(200, { job_id: 'jl', hash: H4, state: up.lyr.ready ? 'done' : 'running', position: 0 }); }
    if (req.url.startsWith('/playlists')) {
      pl.calls.push(`${req.method} ${req.url}${body ? ' ' + body : ''}`);
      const m = req.url.match(/^\/playlists\/([0-9a-f]{12})$/), one = m && pl.list.find((x) => x.id === m[1]);
      if (req.url === '/playlists' && req.method === 'GET') return json(200, pl.list.map(({ songs, ...rest }) => rest));
      if (req.url === '/playlists' && req.method === 'POST') {
        const j = JSON.parse(body), p = { id: 'abcdef012345', title: j.title, songs: j.songs, count: j.songs.length, has_cover: false, created_at: 'c', updated_at: 'u1' };
        pl.list.push(p); return json(201, p);
      }
      if (one && req.method === 'GET') return json(200, one);
      if (one && req.method === 'DELETE') { pl.list = pl.list.filter((x) => x !== one); res.writeHead(204); return res.end(); }
      if (m) return json(404, { detail: 'Playlist not found' });
    }
    if (req.url === `/library/${H4}/zip`) { up.zips.push(H4); res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length }); return res.end(zip); }
    if (req.url === `/library/${H1}/zip`) {
      up.zips.push(H1);
      // Lento a proposito: 5 trozos cada 300 ms, para ver la ola de descarga
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length });
      const n = 5, step = Math.ceil(zip.length / n);
      for (let i = 0; i < n; i++) { res.write(zip.subarray(i * step, (i + 1) * step)); await new Promise((r) => setTimeout(r, 300)); }
      return res.end();
    }
    json(404, { detail: 'nope' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, pl, up, del, close: () => srv.close() };
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
  ctx = { page, fake: api, url: `http://localhost:${port}/app/`, close: async () => { await page.close(); await vite.close(); api.close(); } };
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
    // Centro sin cancion: nebulosa girando (color) y la marca en blanco en el medio
    await new Promise((r) => setTimeout(r, 600));
    const idle = await p.eval(`(() => {
      const n = document.querySelector('.main.idle .idleneb'), m = document.querySelector('.main.idle .idlemark');
      if (!n || !m) return null;
      const px = (c, f) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 0; i < d.length; i += 4) if (f(d[i], d[i + 1], d[i + 2], d[i + 3])) k++; return k / (d.length / 4); };
      return { color: px(n, (r, g, b, a) => a > 0 && Math.max(r, g, b) > 20), white: px(m, (r, g, b, a) => a > 200 && r > 240 && g > 240 && b > 240) };
    })()`);
    expect(idle && idle.color > 0.3 && idle.white > 0.05, `centro sin cancion: ${JSON.stringify(idle)}`);
    // Sin descargadas no hay filtro: solo el total (un hidden pisado por CSS lo dejaba visible)
    const bar = await p.eval(`(() => { const f = document.querySelector('.flt'), n = document.querySelector('.bar2 .count'); return { flt: f.getClientRects().length > 0, count: n.getClientRects().length > 0 }; })()`);
    expect(!bar.flt && bar.count, `cabecera sin descargadas: filtro ${bar.flt ? 'visible' : 'oculto'}, total ${bar.count ? 'visible' : 'oculto'}`);
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
    expect(!(await p.eval(`!!document.querySelector('.main.idle')`)), 'el centro vacio sigue con cancion abierta');
    return `centro vacio ${(idle.color * 100).toFixed(0)} % color + marca ${(idle.white * 100).toFixed(0)} %, ola ${(wave * 100).toFixed(0)} % pintada, telon con arco (${cur.white}/64), stems: ${names}; ajustes: ${tempo}`;
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

test('diagramas: guitarra pintada, vocabulario, piano sin zonas, clic = seek y se recuerda', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  await p.eval(`document.querySelectorAll('.seg2 button')[1].click()`);
  await p.eval(`document.querySelectorAll('.cdsel .seg')[0].querySelectorAll('button')[1].click()`); // guitarra
  // Blanco del diagrama actual: con forma (dedos) pinta mucho mas que la rejilla vacia
  const lit = `(() => { const cv = document.querySelector('.cdcard.cur canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++; return n; })()`;
  await p.waitFor(`${lit} > 2000`, 8000);
  const g = await p.eval(lit);
  const vocab = await p.eval(`[...document.querySelectorAll('.cdmini b')].map((b) => b.textContent).join(',')`);
  expect(vocab === 'C,G,Am', `vocabulario: ${vocab}`);
  const zoneShown = (await p.eval(`getComputedStyle(document.querySelectorAll('.cdsel .seg')[1]).visibility`)) === 'visible';
  // Piano: teclas con nombre, sin selector de zona
  await p.eval(`document.querySelectorAll('.cdsel .seg')[0].querySelectorAll('button')[0].click()`);
  await new Promise((r) => setTimeout(r, 200));
  const pianoZone = await p.eval(`getComputedStyle(document.querySelectorAll('.cdsel .seg')[1]).visibility`);
  const pianoLit = await p.eval(lit);
  expect(zoneShown && pianoZone === 'hidden' && pianoLit > 300, `zona con guitarra ${zoneShown}, con piano ${pianoZone}; piano ${pianoLit} px`);
  // Clic en Am del vocabulario: la cancion salta a su beat (12 s) y Am pasa a actual
  await p.eval(`[...document.querySelectorAll('.cdmini')].find((b) => b.textContent.startsWith('Am')).click()`);
  await p.waitFor(`document.querySelector('.cdcard.cur .cdname b')?.textContent === 'Am'`, 4000);
  const pref = await p.eval(`localStorage.getItem('fision.chordInstrument')`);
  await p.eval(`document.querySelectorAll('.cdsel .seg')[0].querySelectorAll('button')[1].click()`);
  await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`);
  expect(pref === 'piano', `instrumento guardado: ${pref}`);
  return `guitarra ${g} px blancos, vocabulario ${vocab}, piano ${pianoLit} px, seek a Am`;
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
  // Tele: caratula con texto blanco abajo y luz trasera con color
  await p.waitFor(`${sc}.screen && ${sc}.screen.token > 0`, 3000);
  await new Promise((r) => setTimeout(r, 300));
  const tv = await p.eval(`(() => { const s = ${sc}.screen;
    const d = s.card.getContext('2d').getImageData(64, 700, 896, 260).data; let white = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
    const g = s.glow.getContext('2d').getImageData(0, 0, 256, 256).data; let lit = 0;
    for (let i = 3; i < g.length; i += 4) if (g[i] > 20) lit++;
    return { white, lit }; })()`);
  expect(tv.white > 500 && tv.lit > 5000, `tele: ${tv.white} px de texto, ${tv.lit} px de luz trasera`);
  // Dollhouse: camara fuera por +X -> esa pared y sus dos pilares se ocultan
  const doll = await p.eval(`(() => { const s = ${sc}; s.camera.position.set(6, 1, 0); s.controls.update(); s.bounds();
    const wall = s.walls.find((w) => w.axis === 'x' && w.sign === 1).mesh.visible;
    const traps = s.traps.map((t) => t.sx + ':' + t.mesh.visible).join(',');
    s.camera.position.set(0, 2, -4); s.controls.update(); s.bounds(); s.dirty = true;
    return { wall, traps }; })()`);
  expect(!doll.wall && doll.traps === '-1:true,-1:true,1:false,1:false', `dollhouse: pared ${doll.wall}, pilares ${doll.traps}`);
  // Mezcla bloqueada con el 3D encendido
  await p.eval(`[...document.querySelectorAll('.seg2 button')][2].click()`);
  const locked = await p.eval(`!!document.querySelector('.note3d') && [...document.querySelectorAll('.stem input')].every((i) => i.disabled)`);
  await p.eval(`[...document.querySelectorAll('.seg2 button')][3].click()`);
  await p.eval(`document.querySelector('.d3head .switch').click()`); // deja el 3D como estaba
  expect(locked, 'mezcla sin bloquear en 3D');
  return `pintado ${(on.lit * 100).toFixed(0)} %, brillo ${off.mean.toFixed(0)} -> ${on.mean.toFixed(0)}, tele ${tv.white} px de texto, dollhouse, arrastre, omni, mute, baile, reset y mezcla bloqueada`;
});

test('playlists: vacia, crear con el editor (solo las de la nube), abrirla, volver y borrar', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page, calls = c.fake.pl.calls;
  await p.waitFor(`document.querySelector('.plsec .empty')`, 5000);
  await p.eval(`document.querySelector('.pladd').click()`);
  await p.waitFor(`document.querySelector('dialog.pled')`, 3000);
  // Sin titulo no se envia nada
  const before = calls.length;
  await p.eval(`document.querySelector('.plfoot .btn:not(.ghost)').click()`);
  const noTitle = await p.eval(`document.querySelector('.plerr').textContent`);
  expect(noTitle && calls.length === before, `sin titulo: "${noTitle}", peticiones ${calls.length - before}`);
  await p.eval(`(() => { const i = document.querySelector('dialog.pled input.field'); i.value = 'Ensayo'; i.dispatchEvent(new Event('input')); })()`);
  await p.eval(`[...document.querySelectorAll('dialog.pled .btn.ghost')].find((b) => b.getAttribute('aria-expanded') !== null).click()`);
  const offer = await p.eval(`[...document.querySelectorAll('.plpk b')].map((b) => b.textContent).join(',')`);
  expect(offer === 'Cancion buena', `se ofrecen: ${offer}`); // ni la rota ni la de la cola
  await p.eval(`document.querySelector('.plpk').click()`);
  await p.eval(`document.querySelector('.plfoot .btn:not(.ghost)').click()`);
  await p.waitFor(`!document.querySelector('dialog.pled') && document.querySelector('.plhead:not([hidden])')`, 5000);
  const post = calls.find((x) => x.startsWith('POST /playlists'));
  expect(post && JSON.parse(post.slice(post.indexOf('{'))).songs.length === 1, `POST: ${post}`);
  const opened = await p.eval(`({ head: document.querySelector('.plhead .plt b').textContent, rows: [...document.querySelectorAll('.list .dr b')].map((b) => b.textContent).join(','), side: document.querySelector('.plr .pc').textContent })`);
  expect(opened.head === 'Ensayo' && opened.rows === 'Cancion buena' && opened.side === '1', JSON.stringify(opened));
  await p.eval(`document.querySelector('.plback').click()`);
  const back = await p.eval(`document.querySelectorAll('.list .dr').length`);
  // Borrar desde el menu de la playlist
  await p.eval(`document.querySelector('.plr').click()`);
  await p.waitFor(`document.querySelector('.plhead:not([hidden]) .plopt')`, 3000);
  await p.eval(`window.confirm = () => true; document.querySelector('.plopt').click()`);
  await p.eval(`document.querySelector('.plhead .menu .danger').click()`);
  await p.waitFor(`document.querySelector('.plsec .empty') && document.querySelector('.plhead').hidden`, 5000);
  const toastText = await p.eval(`document.querySelector('.toast')?.textContent ?? ''`);
  expect(back === 3 && calls.some((x) => x.startsWith('DELETE /playlists/abcdef012345')) && toastText, `vuelta ${back} filas, aviso "${toastText}"`);
  return `creada y abierta; se ofrece solo ${offer}; borrada ("${toastText}")`;
});

test('anadir: comprueba antes de subir, sube con config; al acabar el job se descarga; reprocesar', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page, up = c.fake.up;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fision-up-'));
  const btnSend = `document.querySelector('dialog.imp .plfoot .btn:not(.ghost)')`;
  try {
    const short = path.join(tmp, 'corta.wav'), good = path.join(tmp, 'subida.wav');
    fs.writeFileSync(short, sineWav(440, 5)); fs.writeFileSync(good, sineWav(440, 20));
    const choose = async (file) => {
      await p.waitFor(`document.querySelector('input.pick-audio')`, 3000);
      const doc = await p.send('DOM.getDocument', {});
      const q = await p.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input.pick-audio' });
      await p.send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [file] });
    };
    // Sin ventana el selector se cancelaria solo: se intercepta y se rellena el input
    await p.send('Page.enable');
    await p.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await p.eval(`document.querySelector('.addb').click()`);
    await choose(short);
    try { await p.waitFor(`document.querySelector('dialog.imp') && !${btnSend}.disabled`, 5000); }
    catch { throw new Error(`dialogo: ${await p.eval(`JSON.stringify({ dlg: !!document.querySelector('dialog.imp'), input: !!document.querySelector('input.pick-audio'), files: document.querySelector('input.pick-audio')?.files?.length, load: document.querySelector('.imload')?.hidden })`)}`); }
    const warn = await p.eval(`!document.querySelector('.imwarn').hidden`);
    await p.waitFor(`/0:05/.test(document.querySelector('.imtx small').textContent)`, 5000);
    // Corta: no se sube nada
    await p.eval(`${btnSend}.click()`);
    const shortErr = await p.eval(`document.querySelector('dialog.imp .plerr').textContent`);
    expect(warn && /15/.test(shortErr) && up.calls.length === 0, `sin GPU avisa ${warn}; corta: "${shortErr}", subidas ${up.calls.length}`);
    // Cambiar de cancion y pasar a personalizada tocando guitarra
    await p.eval(`document.querySelector('.imhero .btn.ghost').click()`);
    await choose(good);
    await p.waitFor(`/0:20/.test(document.querySelector('.imtx small').textContent)`, 5000);
    await p.eval(`document.querySelectorAll('.imtile')[1].click()`);
    const custom = await p.eval(`document.querySelectorAll('dialog.imp .seg button')[2].getAttribute('aria-checked')`);
    await p.eval(`${btnSend}.click()`);
    await p.waitFor(`!document.querySelector('dialog.imp')`, 10000);
    const sent = up.calls[0];
    expect(custom === 'true' && sent && /^multipart\/form-data/.test(sent.type) && sent.name === 'subida.wav', `subida: ${JSON.stringify(sent)}`);
    const cfg = JSON.parse(sent.cfg);
    expect(cfg.device === 'cpu' && cfg.chords === 'btc' && cfg.sep.mode === 'personalized' && cfg.sep.stems.guitar.enabled && cfg.sep.stems.bass.enabled, `config: ${sent.cfg}`);
    // El job acaba (sondeo de 4 s): la cancion nueva se descarga sola
    await p.waitFor(`[...document.querySelectorAll('.dr')].some((r) => r.textContent.includes('Subida') && !r.classList.contains('cld') && !r.querySelector('.spin'))`, 20000);
    expect(up.zips.includes(H4), `zips pedidos: ${up.zips.join()}`);
    // Reprocesar la que suena desde el menu: form con el config, y se vuelve a bajar
    await p.eval(`[...document.querySelectorAll('.dr')].find((r) => r.textContent.includes('Cancion buena')).click()`);
    await p.waitFor(`document.querySelector('.top .t b')?.textContent === 'Cancion buena' && !document.querySelector('canvas.curtain-c')`, 10000);
    const before = up.zips.filter((z) => z === H1).length;
    await p.eval(`document.querySelector('.top .ib').click()`);
    await p.eval(`document.querySelector('.menu-pop .menuitem').click()`);
    await p.waitFor(`document.querySelector('dialog.imp') && !${btnSend}.disabled`, 5000);
    await p.eval(`${btnSend}.click()`);
    await p.waitFor(`!document.querySelector('dialog.imp')`, 5000);
    const rp = up.calls.find((x) => x.reprocess)?.reprocess ?? '';
    for (let i = 0; i < 80 && up.zips.filter((z) => z === H1).length === before; i++) await new Promise((r) => setTimeout(r, 250));
    const after = up.zips.filter((z) => z === H1).length;
    expect(rp.startsWith('config_json={"sep"') && after > before, `reproceso: "${rp}", zips H1 ${before} -> ${after}`);
    await p.send('Page.setInterceptFileChooserDialog', { enabled: false });
    return `corta rechazada, subida ${sent.name} (${cfg.sep.mode}, ${cfg.device}), descargada al acabar; reproceso y nueva descarga`;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('letra: sin letra se elige idioma y se pide; el job de letra no ocupa la fila; al acabar se ve', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page, lyr = c.fake.up.lyr;
  const row = `[...document.querySelectorAll('.dr')].find((r) => r.textContent.includes('Subida'))`;
  await p.eval(`${row}.click()`);
  await p.waitFor(`document.querySelector('.top .t b')?.textContent === 'Subida' && !document.querySelector('canvas.curtain-c')`, 10000);
  await p.eval(`document.querySelectorAll('.seg2 button')[0].click()`);
  await p.waitFor(`document.querySelector('.lystate .lycard')`, 5000);
  const auto = await p.eval(`document.querySelector('.lycard b').textContent`);
  await p.eval(`document.querySelector('.lycard').click()`);
  await p.waitFor(`document.querySelectorAll('dialog.lydlg .lylang').length === 28`, 3000);
  await p.eval(`[...document.querySelectorAll('.lylang')].find((b) => /Español|Spanish/.test(b.textContent)).click()`);
  await p.eval(`document.querySelector('.lystate .btn:not(.ghost)').click()`);
  await p.waitFor(`document.querySelector('.lystate[role=status]')`, 3000);
  expect(/Auto/.test(auto) && lyr.posts[0] === '{"language":"es"}', `idioma: ${auto} -> POST ${lyr.posts[0]}`);
  // Con el job de letra en marcha la fila no pasa a "procesando"
  await new Promise((r) => setTimeout(r, 500));
  const busyRow = await p.eval(`!!${row}.querySelector('.spin')`);
  try { await p.waitFor(`document.querySelectorAll('.lyrics .cl').length > 0`, 15000); }
  catch { throw new Error(`sin letra: "${await p.eval(`document.querySelector('.view')?.textContent?.slice(0, 120)`)}", sondeos ${lyr.polls}, posts ${lyr.posts.length}`); }
  expect(!busyRow, 'la fila se marco como procesando por el job de letra');
  await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`);
  return `Auto -> ${lyr.posts[0]}, ${lyr.polls} sondeos, letra visible`;
});

test('exportar: mezcla WAV con metronomo a la carpeta elegida; pista con eco (cola) desde el panel', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  // Carpeta "elegida" = una carpeta de OPFS (el selector real no se automatiza)
  await p.eval(`window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('exp-test', { create: true })`);
  const files = `(async () => { const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('exp-test')).getDirectoryHandle('Prueba - Subida');
    const out = []; for await (const [n, h] of d.entries()) { const f = await h.getFile(); const b = new Uint8Array(await f.slice(0, 12).arrayBuffer()); out.push([n, f.size, String.fromCharCode(...b.subarray(0, 4)), String.fromCharCode(...b.subarray(4, 8))]); } return out; })()`;
  const opt = (i) => p.eval(`document.querySelectorAll('dialog.expdlg .expopt')[${i}].click()`);
  await p.eval(`document.querySelector('.top .ib').click()`);
  await p.eval(`[...document.querySelectorAll('.menu-pop .menuitem')].find((b) => /Exportar|Export/.test(b.textContent)).click()`);
  await p.waitFor(`document.querySelector('dialog.expdlg .expopt')`, 3000);
  await opt(0); await opt(0); // mezcla, volumen por defecto
  await p.waitFor(`document.querySelector('dialog.expdlg .expchk input')`, 3000);
  const checks = await p.eval(`[...document.querySelectorAll('dialog.expdlg .expchk')].map((l) => l.textContent).join('|')`);
  await p.eval(`document.querySelector('dialog.expdlg .expchk input').click()`); // metronomo
  await opt(0); // WAV
  await p.waitFor(`!document.querySelector('dialog.expdlg') && /completa|complete/i.test(document.querySelector('.toast')?.textContent ?? '')`, 20000);
  const mix = (await p.eval(files)).find((f) => f[0].includes('_mix_'));
  // 20 s a 48 kHz, estereo PCM16
  expect(/metr/i.test(checks) && mix && /^Prueba - Subida_mix_\d{8}_\d{6}\.wav$/.test(mix[0]) && mix[1] === 44 + 20 * 48000 * 4 && mix[2] === 'RIFF', `mezcla: ${JSON.stringify(mix)}, casillas ${checks}`);
  // Pista con eco desde el panel: casilla de efectos marcada y cola tras los 20 s
  await p.eval(`[...document.querySelectorAll('.stem .nm')].find(b => /Voz|Vocals/.test(b.textContent)).click()`);
  await p.waitFor(`document.querySelector('.fxtop .expb')`, 3000);
  await p.eval(`(() => { const r = document.querySelectorAll('.fxpanel input')[2]; r.value = '60'; r.dispatchEvent(new Event('input')); })()`);
  await p.eval(`document.querySelector('.fxtop .expb').click()`);
  await p.waitFor(`document.querySelector('dialog.expdlg .expopt')`, 3000);
  const fxOn = await p.eval(`[...document.querySelectorAll('dialog.expdlg .expchk')].some((l) => /efect|effect/i.test(l.textContent) && l.querySelector('input').checked)`);
  const m4a = await p.eval(`!document.querySelectorAll('dialog.expdlg .expopt')[1].hidden`);
  await opt(m4a ? 1 : 0);
  await p.waitFor(`!document.querySelector('dialog.expdlg')`, 30000);
  const one = (await p.eval(files)).find((f) => f[0].includes('_vocals_'));
  const ok = m4a ? one?.[3] === 'ftyp' && one[1] > 50000 : one?.[1] > 44 + 20 * 48000 * 4;
  expect(fxOn && ok, `pista: ${JSON.stringify(one)}, efectos marcados ${fxOn}, m4a ${m4a}`);
  await p.eval(`(() => { const r = document.querySelectorAll('.fxpanel input')[2]; r.value = '0'; r.dispatchEvent(new Event('input')); })()`);
  return `mezcla ${mix[0]} (${(mix[1] / 1048576).toFixed(1)} MB); pista ${one[0]} (${(one[1] / 1024).toFixed(0)} KB${m4a ? ', M4A' : ''})`;
});

test('borrar: en cola se saca de la cola; descargada borra la copia (y para si suena); nube con 409 y luego borrada', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page, del = c.fake.del;
  const row = (t) => `[...document.querySelectorAll('.drw')].find((r) => r.querySelector('.dr').textContent.includes('${t}'))`;
  const menu = async (t) => {
    await p.eval(`${row(t)}.querySelector('.more').click()`);
    await p.waitFor(`document.querySelector('.menu.rowmenu')`, 3000);
    return p.eval(`[...document.querySelectorAll('.menu.rowmenu button')].map((b) => b.textContent + (b.disabled ? ' (off)' : ''))`);
  };
  const pickItem = (label) => p.eval(`window.confirm = () => true; [...document.querySelectorAll('.menu.rowmenu button')].find((b) => b.textContent === '${label}').click()`);
  // El menu cabe en la ventana (fijo, no lo recorta la lista)
  const queueItems = await menu('Cancion en cola');
  const box = await p.eval(`(() => { const r = document.querySelector('.menu.rowmenu').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0; })()`);
  await pickItem(queueItems[0]);
  await p.waitFor(`!${row('Cancion en cola')}.querySelector('.spin')`, 10000);
  expect(box && /cola|queue/i.test(queueItems[0]) && del.calls[0] === 'DELETE /jobs/j', `cola: ${queueItems} -> ${del.calls}, en ventana ${box}`);
  // La que suena (Subida, descargada): borra la copia, para y vuelve el centro vacio; queda en la nube
  const localItems = await menu('Subida');
  await pickItem(localItems.at(-1));
  await p.waitFor(`document.querySelector('.main.idle') && ${row('Subida')}.querySelector('.dr').classList.contains('cld')`, 5000);
  expect(/Borrar canción|Delete song/.test(localItems.at(-1)) && del.calls.length === 1, `local: ${localItems}, llamadas ${del.calls}`);
  // Solo en el server: el 1er intento da 409 (aviso y se queda), el 2o la quita de la lista
  const cloudItems = await menu('Cancion rota');
  await pickItem(cloudItems.at(-1));
  await p.waitFor(`/procesándose|processing/.test(document.querySelector('.toast')?.textContent ?? '')`, 5000);
  const stays = await p.eval(`!!${row('Cancion rota')}`);
  await menu('Cancion rota');
  await pickItem(cloudItems.at(-1));
  await p.waitFor(`!${row('Cancion rota')}`, 5000);
  expect(/nube|cloud/i.test(cloudItems.at(-1)) && stays && del.calls.join() === 'DELETE /jobs/j,DELETE H2 409,DELETE H2', `nube: ${cloudItems} -> ${del.calls}, tras 409 sigue ${stays}`);
  return `cola cancelada, copia local borrada con la cancion sonando, nube 409 -> borrada`;
});

test('sin excepciones en la pagina', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const errs = [...c.page.errors];
  await c.close(); ctx = { skip: 'skip — cerrado' };
  expect(!errs.length, errs.join(' | '));
});
