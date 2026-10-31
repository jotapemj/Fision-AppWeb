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
// Token con forma de JWT (sub/exp): sin red la web entra con la sesion guardada
const TOK = `x.${Buffer.from(JSON.stringify({ sub: 'demo', exp: 4102444800 })).toString('base64url')}.y`;
const LYRICS = { language: 'es', segments: [
  { start: 0.5, end: 2, text: 'primera linea', words: [wd(0.5, 1, 'primera'), wd(1, 2, 'linea')] },
  { start: 2.5, end: 4, text: 'segunda linea', words: [wd(2.5, 3, 'segunda'), wd(3, 4, 'linea')] },
  { start: 12, end: 15, text: 'tercera tras pausa', words: [wd(12, 12.5, 'tercera'), wd(12.5, 13, 'tras'), wd(13, 15, 'pausa')] },
] };

// Voz falsa: el seno solo suena donde hay letra (como un stem de voces real; VocalActivity)
function voiceWav(spans) {
  const buf = sineWav(440, 20), sr = 48000;
  for (let i = 0; i < (buf.length - 44) / 4; i++) {
    if (!spans.some(([a, b]) => i >= a * sr && i < b * sr)) buf.writeInt32LE(0, 44 + i * 4);
  }
  return buf;
}

// Server falso: cuenta "demo"/"pw"; H1 lista, H2 con error, H3 en cola
async function fakeServer() {
  const zip = makeZip([
    { name: 'vocals.wav', data: voiceWav([[0.5, 2], [2.5, 4], [12, 15]]) }, { name: 'bass.wav', data: sineWav(110, 20) },
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
  const net = { down: false }; // server inalcanzable
  const ch = { v: null, body: null, gets: [] }; // acordes nuevos en el server (refreshChords)
  const up = { jobs: null, calls: [], zips: [], newReady: false, config: {}, lyr: { posts: [], polls: 0, ready: false } }; // subidas, reprocesos, letra
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/login') return json(200, { token: TOK, user: 'demo', expires_at: '2099-01-01T00:00:00+00:00' });
    if (net.down) return req.socket.destroy(); // server caido: sin respuesta
    if (req.headers.authorization !== `Bearer ${TOK}`) return json(401, { detail: 'Not authenticated' });
    if (req.url === '/auth/refresh') return json(200, { token: TOK, user: 'demo', expires_at: '2099-01-01T00:00:00+00:00' });
    if (req.method === 'DELETE' && req.url === '/jobs/j') { del.calls.push('DELETE /jobs/j'); del.queueGone = true; return json(200, { job_id: 'j', state: 'cancelled' }); }
    if (req.method === 'DELETE' && req.url === `/library/${H2}`) {
      del.calls.push(`DELETE H2${del.busy ? ' 409' : ''}`);
      if (del.busy) { del.busy = false; return json(409, { detail: 'busy', code: 'job_running' }); }
      del.gone = true; return json(200, { hash: H2, deleted: true });
    }
    if (req.url === '/library') {
      const lib = [entry(H1, 'Cancion buena', 'ready', '2026-10-03'), entry(H2, 'Cancion rota', 'error', '2026-10-02'), entry(H3, 'Cancion en cola', del.queueGone ? 'cancelled' : 'processing', '2026-10-01')]
        .filter((x) => !(del.gone && x.hash === H2));
      if (up.newReady !== false) lib.push({ ...entry(H4, 'Subida', up.newReady === true ? 'ready' : 'processing', '2026-10-04'), config: up.config, ...(ch.v ? { updated_at: ch.v } : {}) });
      return json(200, lib);
    }
    if (req.url === '/jobs' && req.method === 'GET') {
      // Un job subido se ve en vuelo una vez y luego acaba
      const extra = up.jobs ? [up.jobs] : [];
      // up.hold: el job sigue en vuelo (la prueba mira la fila mientras procesa)
      if (up.jobs) { up.jobs = null; up.newReady = 'pending'; }
      else if (up.newReady === 'pending' && !up.hold) up.newReady = true;
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
    if (req.url.startsWith(`/library/${H4}/stems/chords`)) {
      ch.gets.push(req.url.split('/').pop());
      if (req.url.endsWith('/chords.txt') && ch.body) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(ch.body); }
      return json(404, { detail: 'Not found' });
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
  return { url: `http://127.0.0.1:${srv.address().port}`, pl, up, del, ch, net, close: () => srv.close() };
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

test('sonido en downbeat: interruptor y sonido en el menu; baja el WAV y lo carga en el motor', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  await p.eval(`document.querySelector('.top .ib').click()`);
  await p.waitFor(`document.querySelector('.menu-pop .dbpick')`);
  const hiddenOff = await p.eval(`document.querySelector('.menu-pop .dbpick').hidden`);
  await p.eval(`document.querySelectorAll('.menu-pop .switch')[1].click()`);
  await p.eval(`document.querySelector('.menu-pop .dbpick').click()`);
  const n = await p.eval(`document.querySelectorAll('.menu-pop .dblist button').length`);
  await p.eval(`document.querySelectorAll('.menu-pop .dblist button')[4].click()`); // stick
  await p.waitFor(`performance.getEntriesByType('resource').some((r) => r.name.endsWith('/dbclick_stick.wav'))`, 5000);
  const st = await p.eval(`({ on: document.querySelector('.main').player.downbeatOn, sub: document.querySelector('.menu-pop .dbpick small').textContent,
    saved: JSON.parse(localStorage.getItem('fision.settings')).downbeatType })`);
  await p.eval(`document.querySelectorAll('.menu-pop .switch')[1].click()`); // dejarlo apagado
  const off = await p.eval(`document.querySelector('.main').player.downbeatOn`);
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  expect(hiddenOff && n === 13 && st.on && st.saved === 4 && /Baqueta|Stick/.test(st.sub) && !off, JSON.stringify({ hiddenOff, n, ...st, off }));
  return `13 sonidos; ${st.sub} cargado; apagado de nuevo`;
});

test('letra: la linea activa sigue a la cancion y tocar una linea hace seek', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  await p.eval(`document.querySelectorAll('.seg2 button')[0].click()`);
  await p.waitFor(`document.querySelectorAll('.lyrics .cl').length >= 4`, 10000);
  const kinds = await p.eval(`[...document.querySelectorAll('.lyrics .cl')].map(e => e.classList.contains('ins') ? 'i' : 't').join('')`);
  // Con la voz medida basta un hueco de 4 s: la cola 15-20 s tambien es instrumental (sin medida: ttit)
  expect(kinds === 'ttiti', `filas (texto/instrumental): ${kinds}`);
  // Seek a la tercera linea tocandola
  await p.eval(`document.querySelectorAll('.lyrics .cl')[3].click()`);
  // Se enciende al tocar (retencion), sin esperar a que el reloj llegue
  await p.waitFor(`document.querySelectorAll('.lyrics .cl')[3].classList.contains('now')`, 300);
  await p.waitFor(`document.querySelector('.seek .meta span').textContent === '00:12'`, 5000);
  const pos = await p.eval(`document.querySelector('.seek .meta span').textContent`);
  const nNow = await p.eval(`document.querySelectorAll('.lyrics .cl.now').length`);
  expect(pos === '00:12' && nNow === 1, `tras tocar: posicion ${pos}, activas ${nNow}`);
  // La pagina no crece con la letra: el transporte sigue dentro de la ventana
  const lay = await p.eval(`({ doc: document.documentElement.scrollHeight, vh: innerHeight, bar: document.querySelector('.pbar').getBoundingClientRect().bottom, scroller: document.querySelector('.lyrics').scrollHeight > document.querySelector('.lyrics').clientHeight })`);
  expect(lay.doc <= lay.vh && Math.round(lay.bar) <= lay.vh && lay.scroller, `pagina ${lay.doc}px en ventana ${lay.vh}px, transporte acaba en ${Math.round(lay.bar)}px, letra con scroll propio: ${lay.scroller}`);
  await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`); // volver a Mezcla para las medidas
  return `filas ${kinds}, seek a ${pos}`;
});

test('letra magnetica: cerca del centro se engancha y vuelve; lejos se desprende; un seek la engancha', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  const playing = await p.eval(`/pau/i.test(document.querySelector('.pbar .play').getAttribute('aria-label'))`);
  if (playing) await p.eval(`document.querySelector('.pbar .play').click()`);
  await p.eval(`document.querySelectorAll('.seg2 button')[0].click()`);
  try {
    await p.waitFor(`document.querySelectorAll('.lyrics .cl').length >= 4`, 10000);
    await p.eval(`document.querySelectorAll('.lyrics .cl')[1].click()`);
    await new Promise((r) => setTimeout(r, 900));
    // Distancia (px) de la linea activa al centro del scroller
    const off = `(() => { const b = document.querySelector('.lyrics'), n = b.querySelector('.cl.now'); const r = n.getBoundingClientRect(), q = b.getBoundingClientRect();
      return Math.round((r.top + r.height / 2) - (q.top + q.height / 2)); })()`;
    const scrollBy = (dy) => p.eval(`(() => { const b = document.querySelector('.lyrics'); b.dispatchEvent(new WheelEvent('wheel', { deltaY: ${dy} })); b.scrollTop += ${dy}; })()`);
    const o0 = await p.eval(off);
    // Cerca (60 px): al soltar vuelve al centro
    await scrollBy(60);
    await new Promise((r) => setTimeout(r, 900));
    const near = await p.eval(off);
    // Lejos (todo abajo): se queda donde se dejo
    await scrollBy(4000);
    await new Promise((r) => setTimeout(r, 900));
    const far = await p.eval(off);
    const det = await p.eval(`document.querySelector('.lyrics').scrollTop`);
    // Un seek (+5 s) la engancha otra vez
    await p.eval(`[...document.querySelectorAll('.pbar button')].find((b) => /Adelante 5|Forward 5/.test(b.getAttribute('aria-label') || '')).click()`);
    await new Promise((r) => setTimeout(r, 1200));
    const back = await p.eval(off);
    expect(Math.abs(o0) < 30 && Math.abs(near) < 30, `cerca: ${o0} -> ${near} px del centro`);
    expect(Math.abs(far) > 150 && det > 0, `lejos no vuelve: ${far} px`);
    expect(Math.abs(back) < 30, `tras el seek: ${back} px`);
    return `cerca vuelve (${near} px), lejos se queda (${far} px), seek engancha (${back} px)`;
  } finally {
    await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`);
    if (playing) await p.eval(`document.querySelector('.pbar .play').click()`);
  }
});

test('acordes: tira por beat, sin ahora/luego; acordes sobre la letra con su boton', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  await p.eval(`document.querySelectorAll('.seg2 button')[1].click()`);
  await p.waitFor(`document.querySelectorAll('.strip .c').length === 40`, 5000);
  const bars = await p.eval(`document.querySelectorAll('.strip .bar').length`);
  await p.eval(`document.querySelectorAll('.strip .c')[24].click()`); // 12.5 s, suena Am
  await p.waitFor(`document.querySelector('.strip .c.now') === document.querySelectorAll('.strip .c')[24]`, 5000);
  const nowNext = await p.eval(`!!document.querySelector('.now-ch')`);
  expect(bars === 9 && !nowNext, `barras ${bars}, ahora/luego ${nowNext}`);
  // Letra: acordes ocultos por defecto; el boton (solo con acordes) los enciende por cancion
  await p.eval(`document.querySelectorAll('.seg2 button')[0].click()`);
  await p.waitFor(`document.querySelector('.lyopts .lychb')`, 5000);
  const off = await p.eval(`({ btn: !document.querySelector('.lychb').hidden, pressed: document.querySelector('.lychb').getAttribute('aria-pressed'),
    vis: [...document.querySelectorAll('.lyrics .lc')].some((e) => +getComputedStyle(e).opacity > 0.05) })`);
  expect(off.btn && off.pressed === 'false' && !off.vis, `apagado por defecto: ${JSON.stringify(off)}`);
  await p.eval(`document.querySelector('.lychb').click()`);
  await new Promise((r) => setTimeout(r, 600));
  // G (2.5 s) justo encima de "segunda" (2.5-3.0); el nombre no tapa la palabra
  const over = await p.eval(`(() => {
    const out = [];
    for (const line of document.querySelectorAll('.lyrics .cl:not(.ins)')) {
      const ws = [...line.querySelectorAll('.wd')];
      for (const c of line.querySelectorAll('.lc')) {
        const cr = c.getBoundingClientRect();
        const w = ws.find((x) => { const r = x.getBoundingClientRect(); return Math.abs(r.left - cr.left) < 3 && cr.bottom <= r.top + 6 && r.top - cr.bottom < 14; });
        out.push(c.textContent + '>' + (w ? w.textContent : '?'));
      }
    }
    return out.join(' ');
  })()`);
  const saved = await p.eval(`document.querySelector('.main').player.chordsOnLyrics`);
  expect(over.includes('G>segunda') && !over.includes('?') && saved, `acordes sobre palabras: ${over}, guardado ${saved}`);
  await p.eval(`document.querySelector('.lychb').click()`); // apagado otra vez
  await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`);
  return `sin ahora/luego; ${over}`;
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

test('tira: arrastrar con el raton explora sin seek; al soltar se ajusta y el iman vuelve; clic = seek', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  const playing = await p.eval(`/pau/i.test(document.querySelector('.pbar .play').getAttribute('aria-label'))`);
  if (playing) await p.eval(`document.querySelector('.pbar .play').click()`);
  await p.eval(`document.querySelectorAll('.seg2 button')[1].click()`);
  try {
    await p.waitFor(`document.querySelectorAll('.strip .c').length === 40`, 5000);
    await p.eval(`document.querySelectorAll('.strip .c')[4].click()`); // 2.5 s
    await p.waitFor(`document.querySelector('.strip .c.now') === document.querySelectorAll('.strip .c')[4]`, 5000);
    await new Promise((r) => setTimeout(r, 400));
    const st = `(() => { const s = document.querySelector('.strip'), n = s.querySelector('.c.now'); return { x: n.getBoundingClientRect().left - s.getBoundingClientRect().left, w: s.clientWidth,
      pos: document.querySelector('.seek .meta span').textContent, now: [...s.querySelectorAll('.c')].indexOf(n) }; })()`;
    const s0 = await p.eval(st);
    const box = await p.eval(`(() => { const r = document.querySelector('.strip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const mouse = (type, x) => p.send('Input.dispatchMouseEvent', { type, x, y: box.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    // Arrastre lento de 560 px a la izquierda (~8 celdas): sin seek, la tira se mueve
    await mouse('mousePressed', box.x);
    for (let k = 1; k <= 14; k++) { await mouse('mouseMoved', box.x - 40 * k); await new Promise((r) => setTimeout(r, 16)); }
    await new Promise((r) => setTimeout(r, 120));
    await mouse('mouseReleased', box.x - 560);
    await new Promise((r) => setTimeout(r, 450));
    const s1 = await p.eval(st);
    const snapped = await p.eval(`(() => { const s = document.querySelector('.strip'), sl = s.getBoundingClientRect().left + s.clientWidth / 3;
      return Math.min(...[...s.querySelectorAll('.c')].map((c) => Math.abs(c.getBoundingClientRect().left - sl))); })()`);
    expect(s1.pos === s0.pos && s1.now === s0.now, `el arrastre hizo seek: ${s0.pos} -> ${s1.pos}`);
    expect(s0.x - s1.x > 400 && snapped < 2, `explorando: ${s0.x.toFixed(0)} -> ${s1.x.toFixed(0)} px, ajuste ${snapped.toFixed(1)} px`);
    // Iman: lejos (8 celdas) espera 1.5 s + 100 ms/celda y vuelve al beat actual
    await p.waitFor(`(() => { const s = document.querySelector('.strip'), n = s.querySelector('.c.now'); return Math.abs(n.getBoundingClientRect().left - s.getBoundingClientRect().left - ${s0.x}) < 2; })()`, 4500);
    // Clic tras explorar con la rueda: seek
    await p.eval(`document.querySelector('.strip').dispatchEvent(new WheelEvent('wheel', { deltaY: 200, cancelable: true }))`);
    await p.eval(`document.querySelectorAll('.strip .c')[24].click()`);
    await p.waitFor(`document.querySelector('.strip .c.now') === document.querySelectorAll('.strip .c')[24]`, 5000);
    return `arrastre ${Math.round(s0.x - s1.x)} px sin seek, ajustado a celda, iman de vuelta; clic = seek`;
  } finally {
    await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`);
    if (playing) await p.eval(`document.querySelector('.pbar .play').click()`);
  }
});

test('cuadricula: sustituye a tira y diagramas, 2 compases por fila, clic = seek, sigue la cancion y vuelve tras explorar', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  // En pausa: la cancion falsa dura 20 s y acabaria durante las esperas
  const playing = await p.eval(`document.querySelector('.pbar .play').getAttribute('aria-label') !== ${JSON.stringify('Reproducir')} && /pau/i.test(document.querySelector('.pbar .play').getAttribute('aria-label'))`);
  if (playing) await p.eval(`document.querySelector('.pbar .play').click()`);
  await p.eval(`document.querySelectorAll('.seg2 button')[1].click()`);
  await p.eval(`document.querySelectorAll('.chpill button')[1].click()`);
  try {
  await p.waitFor(`document.querySelectorAll('.cgrid .g').length === 40`, 5000);
  const lay = await p.eval(`(() => {
    const g = [...document.querySelectorAll('.cgrid .g')], r = (e) => e.getBoundingClientRect();
    const row0 = g.filter((e) => Math.abs(r(e).top - r(g[0]).top) < 2).length;
    return { strip: !!document.querySelector('.view .strip'), diag: !!document.querySelector('.view .cdg'), row0, b2: g[4].classList.contains('b2'),
      gapBar: Math.round(r(g[4]).left - r(g[3]).right), gapBeat: Math.round(r(g[1]).left - r(g[0]).right), square: Math.abs(r(g[0]).width - r(g[0]).height) < 1.5 };
  })()`);
  expect(!lay.strip && !lay.diag && lay.row0 === 8 && lay.b2 && lay.gapBar > lay.gapBeat && lay.square, `maqueta: ${JSON.stringify(lay)}`);
  // Clic en la casilla 25 (12.5 s, Am) = seek; la fila actual queda al ~30 % del alto
  await p.eval(`document.querySelectorAll('.cgrid .g')[25].click()`);
  try { await p.waitFor(`document.querySelector('.cgrid .g.now') === document.querySelectorAll('.cgrid .g')[25]`, 5000); }
  catch { throw new Error(await p.eval(`JSON.stringify({ now: [...document.querySelectorAll('.cgrid .g')].indexOf(document.querySelector('.cgrid .g.now')), pos: document.querySelector('.seek .meta span').textContent, play: document.querySelector('.pbar .play').getAttribute('aria-label'), playing: ${playing} })`)); }
  const at = () => p.eval(`(() => { const g = document.querySelector('.cgrid'), n = g.querySelector('.g.now'); return (n.getBoundingClientRect().top - g.getBoundingClientRect().top) / g.clientHeight; })()`);
  await new Promise((r) => setTimeout(r, 900));
  const followed = await at();
  expect(followed > 0.2 && followed < 0.4, `fila actual al ${(followed * 100).toFixed(0)} % del alto`);
  // Explorar (rueda) la separa; al soltar, el iman la devuelve
  await p.eval(`(() => { const g = document.querySelector('.cgrid'); g.dispatchEvent(new WheelEvent('wheel', { deltaY: 600 })); g.scrollTop = g.scrollHeight; })()`);
  await new Promise((r) => setTimeout(r, 300));
  const away = await at();
  await p.waitFor(`(() => { const g = document.querySelector('.cgrid'), n = g.querySelector('.g.now'); const k = (n.getBoundingClientRect().top - g.getBoundingClientRect().top) / g.clientHeight; return k > 0.2 && k < 0.4; })()`, 6000);
  // Se recuerda
  const pref = await p.eval(`localStorage.getItem('fision.chordView')`);
  expect(pref === '1', `preferencia ${pref}`);
    return `8 por fila, seek a Am, fila al ${(followed * 100).toFixed(0)} %, explorando ${(away * 100).toFixed(0)} % -> vuelve`;
  } finally {
    // Se deja en Diagramas y sonando, como estaba, para el resto
    await p.eval(`document.querySelectorAll('.chpill button')[0]?.click()`);
    await p.waitFor(`document.querySelector('.view .strip') && document.querySelector('.view .cdg')`, 3000);
    await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`);
    if (playing) await p.eval(`document.querySelector('.pbar .play').click()`);
  }
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

test('3D plano (Rendimiento: Escena 2D): dummy, luces, arrastre sin cruzar la cabeza, altura, omni, mute, baile y reset', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page;
  const setScene = async (re) => {
    await p.eval(`document.querySelector('.me .gear').click()`);
    await p.waitFor(`document.querySelector('dialog.settings')`, 3000);
    await p.eval(`[...document.querySelectorAll('dialog.settings .seg button')].find((b) => ${re}.test(b.textContent)).click()`);
    await p.eval(`document.querySelector('dialog.settings .xbtn').click()`);
  };
  await setScene('/2D scene|Escena 2D/');
  try {
    await p.eval(`[...document.querySelectorAll('.seg2 button')][3].click()`);
    await p.waitFor(`document.querySelectorAll('.f3 .f3ic').length === 3 && document.querySelector('.f3 .f3head')?.naturalWidth > 0`, 10000);
    const fl = `document.querySelector('.f3').flat3d`;
    const st0 = await p.eval(`({ three: !!document.querySelector('.f3 canvas'), veil: getComputedStyle(document.querySelector('.f3veil')).opacity, inert: document.querySelector('.f3stage').classList.contains('inert') })`);
    expect(!st0.three && +st0.veil > 0.7 && st0.inert, `apagado: ${JSON.stringify(st0)}`);
    await p.eval(`document.querySelector('.f3 .d3head .switch').click()`);
    await new Promise((r) => setTimeout(r, 300));
    expect(+(await p.eval(`getComputedStyle(document.querySelector('.f3veil')).opacity`)) < 0.05, 'luces encendidas');
    const stem = await p.eval(`document.querySelector('.f3 .f3ic').dataset.stem`);
    const mouse = async (type, x, y) => p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    const drag = async (s, dx, dy) => { await mouse('mousePressed', s.x, s.y); for (let k = 1; k <= 8; k++) await mouse('mouseMoved', s.x + dx * k / 8, s.y + dy * k / 8); await mouse('mouseReleased', s.x + dx, s.y + dy); };
    // Arrastre: el icono sigue al raton; el azimut y el radio cambian; cerca = mas grande
    const s0 = await p.eval(`${fl}.probe('${stem}')`);
    await drag(s0, 90, 60);
    const s1 = await p.eval(`${fl}.probe('${stem}')`);
    expect(s1.pose.placed && Math.abs(s1.x - (s0.x + 90)) < 6 && Math.abs(s1.y - (s0.y + 60)) < 6 && s1.pose.fr < s0.pose.fr && s1.scale > s0.scale,
      `arrastre: (${s0.x.toFixed(0)},${s0.y.toFixed(0)}) -> (${s1.x.toFixed(0)},${s1.y.toFixed(0)}), radio ${s0.pose.fr.toFixed(2)} -> ${s1.pose.fr.toFixed(2)}, escala ${s0.scale.toFixed(2)} -> ${s1.scale.toFixed(2)}`);
    // No se mete en la cabeza
    const hd = await p.eval(`(() => { const r = document.querySelector('.f3head').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
    await drag(s1, hd.x - s1.x, hd.y - s1.y);
    const s2 = await p.eval(`${fl}.probe('${stem}')`);
    const ell = ((s2.x - hd.x) / (hd.w * 0.6)) ** 2 + ((s2.y - hd.y) / (hd.h * 0.55)) ** 2;
    expect(ell > 0.98, `dentro de la cabeza: ${ell.toFixed(2)}`);
    // Detras: circulo entero, justo debajo de la cabeza a distancia 1
    const g = await p.eval(`({ ...${fl}.g })`);
    await drag(s2, hd.x - s2.x, hd.y + g.r - s2.y);
    const sb = await p.eval(`${fl}.probe('${stem}')`);
    expect(Math.abs(Math.abs(sb.pose.az) - Math.PI) < 0.1 && sb.pose.fr > 0.95, `detras: az ${(sb.pose.az * 180 / Math.PI).toFixed(0)} fr ${sb.pose.fr.toFixed(2)}`);
    // Altura: el slider vertical de la seleccionada
    await p.eval(`(() => { const r = document.querySelector('.f3 .d3side input'); r.value = 40; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()`);
    const s3 = await p.eval(`${fl}.probe('${stem}')`);
    const elev = Math.atan2(s3.pose.h, s3.pose.rh) * 180 / Math.PI;
    expect(Math.abs(elev - 40) < 0.5, `altura ${elev.toFixed(1)} grados`);
    // Doble clic = omni (y el slider de altura se desactiva); pulsacion larga = mute
    for (let k = 0; k < 2; k++) { await mouse('mousePressed', s3.x, s3.y); await mouse('mouseReleased', s3.x, s3.y); }
    const omni = await p.eval(`({ o: ${fl}.probe('${stem}').pose.omni, cls: document.querySelector('.f3ic[data-stem="${stem}"]').classList.contains('omni'), off: document.querySelector('.f3 .d3side input').disabled })`);
    await mouse('mousePressed', s3.x, s3.y); await new Promise((r) => setTimeout(r, 650)); await mouse('mouseReleased', s3.x, s3.y);
    const muted = (await p.eval(`${fl}.probe('${stem}')`)).pose.muted;
    expect(omni.o && omni.cls && omni.off && muted, `omni ${JSON.stringify(omni)}, mute ${muted}`);
    // Baile: sin swing en el dialogo; gira; panel con velocidad y distancia
    await p.eval(`document.querySelector('.f3 .d3btns .d3btn').click()`);
    await p.waitFor(`document.querySelector('dialog.dance')`, 3000);
    const swing = await p.eval(`document.querySelectorAll('dialog.dance .dswing').length`);
    await p.eval(`document.querySelector('dialog.dance .btn').click()`);
    const a0 = (await p.eval(`${fl}.probe('${stem}')`)).pose.az;
    await new Promise((r) => setTimeout(r, 600));
    const d = await p.eval(`${fl}.probe('${stem}')`);
    const sliders = await p.eval(`document.querySelectorAll('.f3dance input').length`);
    expect(swing === 0 && d.dancing && sliders === 2 && Math.abs(d.pose.az - a0) > 0.05, `baile: swing ${swing}, activo ${d.dancing}, sliders ${sliders}, giro ${(d.pose.az - a0).toFixed(3)}`);
    await p.eval(`document.querySelector('.f3 .d3btns .d3btn').click()`);
    // Reset: al semicirculo, sin omni ni mute ni altura
    await p.eval(`document.querySelector('.f3 .d3btns .d3btn:last-child').click()`);
    await new Promise((r) => setTimeout(r, 1300));
    const after = await p.eval(`[...document.querySelectorAll('.f3ic')].map((b) => ${fl}.probe(b.dataset.stem).pose)`);
    expect(after.every((q) => !q.placed && !q.omni && !q.muted && Math.abs(q.fr - 1) < 1e-9 && Math.abs(q.h) < 1e-9), `reset: ${JSON.stringify(after)}`);
    await p.eval(`document.querySelector('.f3 .d3head .switch').click()`); // deja el 3D apagado
    return `sin three.js; arrastre ${s0.pose.fr.toFixed(2)} -> ${s1.pose.fr.toFixed(2)}, fuera de la cabeza, altura 40, omni, mute, baile, reset`;
  } finally {
    // De vuelta a la escena 3D y a Mezcla para el resto
    await setScene('/^3D scene$|^Escena 3D$/');
    await p.eval(`[...document.querySelectorAll('.seg2 button')][2].click()`);
  }
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

// WAV con LIST INFO + chunk id3 (APIC PNG): lo que leeria MediaMetadataRetriever
function taggedWav(wav) {
  const le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const ss = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  const png = bandsPng(16, 16, [[[40, 200, 120], 1]]);
  const apic = Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3, 0]), png]);
  const frame = (id, d) => Buffer.concat([Buffer.from(id), be(d.length), Buffer.from([0, 0]), d]);
  const tag = Buffer.concat([frame('TIT2', Buffer.from('\0Mi tema', 'latin1')), frame('TPE1', Buffer.from('\0La Autora', 'latin1')), frame('APIC', apic)]);
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), ss(tag.length), tag]);
  const chunk = Buffer.concat([Buffer.from('id3 '), le(id3.length), id3, Buffer.alloc(id3.length & 1)]);
  const out = Buffer.concat([wav.subarray(0, 36), chunk, wav.subarray(36)]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

test('anadir: comprueba antes de subir, sube con config; al acabar el job se descarga; reprocesar', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page, up = c.fake.up;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fision-up-'));
  const btnSend = `document.querySelector('dialog.imp .plfoot .btn:not(.ghost)')`;
  try {
    const short = path.join(tmp, 'corta.wav'), good = path.join(tmp, 'subida.wav');
    fs.writeFileSync(short, sineWav(440, 5)); fs.writeFileSync(good, taggedWav(sineWav(440, 20)));
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
    // Etiquetas del audio en la tarjeta (titulo, artista, portada y su fondo desenfocado)
    await p.waitFor(`document.querySelector('.imhero.pic .imcv img')?.naturalWidth > 0`, 5000);
    const hero = await p.eval(`[document.querySelector('.imtx b').textContent, document.querySelector('.imtx span').textContent, !!document.querySelector('.imbg img')].join('|')`);
    expect(hero === 'Mi tema|La Autora|true', `tarjeta: ${hero}`);
    await p.eval(`document.querySelectorAll('.imtile')[1].click()`);
    const custom = await p.eval(`document.querySelectorAll('dialog.imp .seg button')[2].getAttribute('aria-checked')`);
    up.hold = true;
    await p.eval(`${btnSend}.click()`);
    await p.waitFor(`!document.querySelector('dialog.imp')`, 10000);
    // Mientras procesa, la fila lleva la portada del audio (el server aun no la tiene)
    try { await p.waitFor(`[...document.querySelectorAll('.dr')].some((r) => r.textContent.includes('Subida') && r.querySelector('.cv img'))`, 5000); }
    finally { up.hold = false; }
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
    await p.eval(`[...document.querySelectorAll('.menu-pop .menuitem')].find((b) => /Reprocesar|Reprocess/.test(b.textContent)).click()`);
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

test('acordes nuevos en el server: cambia updated_at -> baja solo chords*.txt y la tira cambia en caliente', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page, ch = c.fake.ch;
  // Acordes de la tira (palabras sueltas)
  const strip = `[...document.querySelectorAll('.strip .c')].flatMap((x) => x.textContent.split(/\\s+/)).filter(Boolean)`;
  const has = (k) => `${strip}.includes('${k}')`;
  await p.eval(`document.querySelectorAll('.seg2 button')[1].click()`);
  expect(await p.eval(has('C')) && !(await p.eval(has('D'))), 'antes: C, sin D');
  ch.body = 'N 0.000\nD 0.500\nG 2.500\nAm 12.000\n'; ch.v = '2026-10-09';
  await p.eval(`document.dispatchEvent(new Event('visibilitychange'))`); // volver a la pestana
  await p.waitFor(has('D'), 8000);
  const gets = ch.gets.join(',');
  expect(gets === 'chords.txt,chords_basic.txt', `pedidos: ${gets}`);
  // Mismo updated_at: no se vuelve a pedir
  await p.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
  await new Promise((r) => setTimeout(r, 800));
  expect(ch.gets.length === 2, `repetido: ${ch.gets.join(',')}`);
  // Deja los acordes como estaban para el resto
  ch.body = 'N 0.000\nC 0.500\nG 2.500\nAm 12.000\n'; ch.v = '2026-10-10';
  await p.eval(`document.dispatchEvent(new Event('visibilitychange'))`);
  await p.waitFor(`!${has('D')}`, 8000);
  await p.eval(`document.querySelectorAll('.seg2 button')[2].click()`);
  return `C -> D en caliente; pedidos ${gets}`;
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

test('sin red: entra con la sesion guardada, biblioteca y playlists de la copia offline; lo descargado suena', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const p = c.page, net = c.fake.net;
  const before = await p.eval(`[...document.querySelectorAll('.dr b')].map((b) => b.textContent).join('|')`);
  net.down = true;
  await p.goto(c.url);
  await p.waitFor(`document.querySelector('.me .who span.off') && document.querySelectorAll('.dr').length === ${before.split('|').length}`, 15000);
  const st = await p.eval(`({ srv: document.querySelector('.me .who span').textContent, rows: [...document.querySelectorAll('.dr b')].map((b) => b.textContent).join('|'), login: !!document.querySelector('.login') })`);
  expect(!st.login && /Servidor sin conexi|Server offline/.test(st.srv), `estado: ${JSON.stringify(st)}`);
  expect(st.rows === before, `filas offline ${st.rows} vs ${before}`);
  // Una descargada se abre y suena sin server
  const local = `[...document.querySelectorAll('.dr')].find((r) => !r.classList.contains('cld'))`;
  expect(await p.eval(`!!${local}`), 'hay una descargada');
  await p.eval(`${local}.click()`);
  await p.waitFor(`document.querySelector('.pbar .seek .meta span') && document.querySelector('.pbar .seek .meta span').textContent !== '00:00'`, 15000);
  // Vuelve la red: se quita el aviso
  net.down = false;
  await p.eval(`dispatchEvent(new Event('online'))`);
  await p.waitFor(`!document.querySelector('.me .who span.off')`, 8000);
  return `${st.srv}; ${st.rows.split('|').length} filas; suena una descargada`;
});

test('sin excepciones en la pagina', async () => {
  const c = await setup(); if (c.skip) return c.skip;
  const errs = [...c.page.errors];
  await c.close(); ctx = { skip: 'skip — cerrado' };
  expect(!errs.length, errs.join(' | '));
});
