// Cliente HTTP contra un server falso que habla el protocolo justo.
import http from 'node:http';
import { test, expect } from './lib/harness.mjs';
import { Api, ApiError } from '../src/api/client.ts';

// Server falso: un usuario, tokens "t1", "t2"...; `dead` invalida todo
async function fakeServer() {
  const state = { n: 0, live: new Set(), dead: false, calls: [] };
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    state.calls.push(`${req.method} ${req.url}`);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    const issue = () => { const t = `t${++state.n}`; state.live.add(t); return { token: t, user: 'demo', expires_at: '2026-11-27T00:00:00+00:00' }; };
    if (req.url === '/login' && req.method === 'POST') {
      const j = JSON.parse(body || '{}');
      return j.username === 'demo' && j.password === 'pw' ? send(200, issue()) : send(401, { detail: 'Wrong username or password' });
    }
    if (state.dead || !state.live.has(tok)) return send(401, { detail: 'Not authenticated' });
    if (req.url === '/auth/refresh') return send(200, issue());
    if (req.url === '/library') return send(200, [{ hash: 'h1', title: 'Airplane Mode', state: 'ready' }]);
    if (req.url === '/library/h1/lyrics') return send(404, { detail: 'No lyrics', code: 'lyrics_missing' });
    if (req.url === '/library/h1/zip') { res.writeHead(200, { 'Content-Length': 5 }); return res.end(Buffer.from([1, 2, 3, 4, 5])); }
    if (req.url === '/library/boom') return send(500, { detail: 'internal stuff', code: 'internal' });
    send(404, { detail: 'nope' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { state, base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

const memStore = () => { let t = null; return { get: () => t, set: (v) => { t = v; } }; };
const codeOf = async (p) => { try { await p; return 'sin error'; } catch (e) { return e instanceof ApiError ? `${e.status}:${e.code}` : String(e); } };

test('login, refresh y biblioteca con token', async () => {
  const s = await fakeServer();
  try {
    const store = memStore(), api = new Api(s.base, store);
    const ses = await api.login('demo', 'pw');
    expect(ses.token === 't1' && store.get() === 't1', `token ${ses.token}`);
    await api.refresh();
    expect(store.get() === 't2', `refresh no guardo el token nuevo: ${store.get()}`);
    const lib = await api.library();
    expect(lib.length === 1 && lib[0].hash === 'h1', 'biblioteca');
    return s.state.calls.join(', ');
  } finally { s.close(); }
});

test('401 en /login = credenciales malas, sin borrar nada', async () => {
  const s = await fakeServer();
  try {
    let fired = false;
    const store = memStore(), api = new Api(s.base, store);
    api.onUnauthorized = () => (fired = true);
    const c = await codeOf(api.login('demo', 'mal'));
    expect(c === '401:bad_credentials', c);
    expect(!fired, 'no debe disparar onUnauthorized');
  } finally { s.close(); }
});

test('401 con token: borra token y avisa (no reintenta)', async () => {
  const s = await fakeServer();
  try {
    let fired = 0;
    const store = memStore(), api = new Api(s.base, store);
    api.onUnauthorized = () => fired++;
    await api.login('demo', 'pw');
    s.state.dead = true;
    const n0 = s.state.calls.length;
    const c = await codeOf(api.library());
    expect(c === '401:unauthorized', c);
    expect(store.get() === null, 'token no borrado');
    expect(fired === 1, `onUnauthorized x${fired}`);
    expect(s.state.calls.length - n0 === 1, 'reintento al server');
  } finally { s.close(); }
});

test('errores por code, nunca detail', async () => {
  const s = await fakeServer();
  try {
    const api = new Api(s.base, memStore());
    await api.login('demo', 'pw');
    const c = await codeOf(api['authed']('/library/boom'));
    expect(c === '500:internal', c);
    const net = await codeOf(new Api('http://127.0.0.1:1', memStore()).login('a', 'b'));
    expect(net === '0:network', net);
  } finally { s.close(); }
});

test('letra 404 = null; zip con progreso', async () => {
  const s = await fakeServer();
  try {
    const api = new Api(s.base, memStore());
    await api.login('demo', 'pw');
    expect((await api.lyrics('h1')) === null, 'letra deberia ser null');
    const prog = [];
    const z = await api.zip('h1', (d, t) => prog.push(`${d}/${t}`));
    expect(z.length === 5 && z[4] === 5, `zip ${z}`);
    expect(prog.at(-1) === '5/5', `progreso ${prog}`);
  } finally { s.close(); }
});
