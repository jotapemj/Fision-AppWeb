// Laboratorio de fase 1: login -> biblioteca -> descarga -> motor.
// Provisional: valida la tuberia antes de montar la UI de las maquetas.
import './lab.css';
import { Api, ApiError, type LibraryEntry } from './api/client';
import { listZip, readZipEntry } from './lib/zip';
import { Engine, type StemFile } from './engine/engine';

const app = document.getElementById('app')!;
const api = new Api();
let engine: Engine | null = null;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
};
const fmt = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
type Stats = { underrunEvents: number; underrunDuration: number; averageLatency: number };
const playbackStats = (c: AudioContext) => (c as AudioContext & { playbackStats?: Stats }).playbackStats;
const errText = (e: unknown) => (e instanceof ApiError ? e.code : String(e));

api.onUnauthorized = () => showLogin();

async function boot() {
  if (!api.hasToken) return showLogin();
  try { await api.refresh(); } catch (e) { if (e instanceof ApiError && e.status === 401) return showLogin(); }
  showLibrary();
}

function showLogin(msg = '') {
  const user = h('input', { type: 'text', placeholder: 'usuario', autocomplete: 'username' });
  const pass = h('input', { type: 'password', placeholder: 'contraseña', autocomplete: 'current-password' });
  const err = h('p', { className: 'err', textContent: msg });
  const form = h('form', {}, user, pass, h('button', { type: 'submit', textContent: 'Entrar' }), err);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api.login(user.value, pass.value); showLibrary(); } catch (e) { err.textContent = errText(e); }
  };
  app.replaceChildren(h('h1', { textContent: 'Fision · laboratorio' }), form);
}

async function showLibrary() {
  const list = h('ul', { className: 'songs' });
  const player = h('section', { textContent: 'Elige una canción.' });
  const out = h('button', { textContent: 'Salir', onclick: () => { api.logout(); showLogin(); } });
  app.replaceChildren(h('div', { className: 'row' }, h('h1', { textContent: 'Fision · laboratorio' }), out), list, player);
  let songs: LibraryEntry[];
  try { songs = await api.library(); } catch (e) { list.replaceChildren(h('li', { className: 'err', textContent: errText(e) })); return; }
  for (const s of songs) {
    const img = h('img', { alt: '' });
    api.cover(s).then((b) => { if (b) img.src = URL.createObjectURL(b); }).catch(() => {});
    const li = h('li', {}, img, h('div', {}, h('div', { textContent: s.title || s.filename }), h('div', { className: 'muted', textContent: `${s.artist} · ${s.state}` })));
    li.onclick = () => openSong(s, player);
    list.append(li);
  }
}

async function openSong(s: LibraryEntry, box: HTMLElement) {
  const log = h('pre');
  const prog = h('div', { className: 'muted' });
  const say = (t: string) => { log.textContent += t + '\n'; };
  box.replaceChildren(h('h2', { textContent: s.title }), prog, log);
  try {
    // El AudioContext nace aqui: hace falta el gesto del usuario
    const tE = performance.now();
    engine ??= await Engine.create('playback');
    say(`motor listo ${(performance.now() - tE).toFixed(0)} ms, ${engine.ctx.sampleRate} Hz`);

    const t0 = performance.now();
    const zip = await api.zip(s.hash, (d, t) => { prog.textContent = `descargando ${t ? Math.round(d / t * 100) + ' %' : (d / 2 ** 20).toFixed(0) + ' MiB'}`; });
    say(`zip ${(zip.length / 2 ** 20).toFixed(0)} MiB en ${(performance.now() - t0).toFixed(0)} ms`);

    const t1 = performance.now();
    const flacs = listZip(zip).filter((e) => e.name.endsWith('.flac'));
    const files: StemFile[] = await Promise.all(flacs.map(async (e) => ({ name: e.name, data: await readZipEntry(zip, e) })));
    say(`descomprimir ${files.length} FLAC: ${(performance.now() - t1).toFixed(0)} ms`);

    const rep = await engine.load(files);
    say(`decodificar: ${rep.wallMs.toFixed(0)} ms con ${rep.threads} hilos (suma ${rep.stems.reduce((a, x) => a + x.decodeMs, 0).toFixed(0)} ms)`);
    say(`total abrir canción: ${(performance.now() - t0).toFixed(0)} ms; duración ${fmt(rep.durationMs)}`);
    mountPlayer(box, rep.stems, rep.durationMs, say);
  } catch (e) { say('ERROR ' + errText(e)); }
}

function mountPlayer(box: HTMLElement, stems: { name: string; id: number }[], durMs: number, say: (t: string) => void) {
  const e = engine!;
  const pos = h('span', { textContent: `0:00 / ${fmt(durMs)}` });
  const seek = h('input', { type: 'range', min: '0', max: '1000', value: '0' });
  let seeking = false;
  seek.onpointerdown = () => (seeking = true);
  seek.onchange = () => { seeking = false; e.seek(+seek.value / 1000 * durMs); };
  const pitchV = h('span', { textContent: '0' });
  const pitch = h('input', { type: 'range', min: '-12', max: '12', step: '1', value: '0', oninput: () => { pitchV.textContent = pitch.value; e.setPitch(+pitch.value); } });
  const tempoV = h('span', { textContent: '1.00x' });
  const tempo = h('input', { type: 'range', min: '0.5', max: '2', step: '0.01', value: '1', oninput: () => { tempoV.textContent = (+tempo.value).toFixed(2) + 'x'; e.setTempo(+tempo.value); } });
  box.append(
    h('div', { className: 'row' }, h('button', { textContent: 'Play', onclick: () => e.play() }), h('button', { textContent: 'Pausa', onclick: () => e.pause() }), seek, pos),
    h('div', { className: 'row' }, 'Tono', pitch, pitchV, 'Tempo', tempo, tempoV),
  );
  for (const s of stems) {
    if (s.id < 0) { say(`stem ${s.name} falló al cargar`); continue; }
    const v0 = s.name.startsWith('metronome') ? 0 : 75; // metronomos mudos, como Android
    const val = h('span', { textContent: String(v0) });
    const r = h('input', { type: 'range', min: '0', max: '100', value: String(v0) });
    r.oninput = () => { val.textContent = r.value; e.setVolume(s.id, +r.value); };
    e.setVolume(s.id, v0);
    box.append(h('div', { className: 'stem' }, h('span', { textContent: s.name.replace('.flac', '') }), r, val));
  }
  // Underruns desde que se monta el reproductor (Chrome: playbackStats)
  const stats = playbackStats(e.ctx);
  const base = stats ? { n: stats.underrunEvents, d: stats.underrunDuration } : null;
  const statsLine = h('div', { className: 'muted' });
  box.append(statsLine);
  const tick = setInterval(() => {
    if (!box.isConnected) return clearInterval(tick);
    const p = e.positionMs;
    pos.textContent = `${fmt(p)} / ${fmt(durMs)}`;
    if (!seeking) seek.value = String(durMs ? p / durMs * 1000 : 0);
    const st = playbackStats(e.ctx);
    if (st && base) statsLine.textContent = `underruns ${st.underrunEvents - base.n} (${((st.underrunDuration - base.d) * 1000).toFixed(0)} ms) · latencia ${(st.averageLatency * 1000).toFixed(0)} ms`;
  }, 250);
}

boot();
