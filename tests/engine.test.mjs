// Motor WASM (build node): se mide la senal renderizada, no el codigo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, expect, near } from './lib/harness.mjs';
import { sineWav as wav } from './lib/zipWriter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'engine/build/node/fision_engine.mjs');
const SR = 48000;

let M = null;
async function engine() {
  if (M) return M;
  if (!fs.existsSync(BUILD)) return null;
  const { default: create } = await import(pathToFileURL(BUILD).href);
  M = await create({ printErr: () => {} });
  M.FS.mkdir('/t');
  return M;
}

const sineWav = (f, sec) => wav(f, sec, SR);

// Carga en paralelo como la web; devuelve ids por fichero
// opts[i] = { seconds, loop, deferred } por fichero (opcional)
async function load(freqs, threads = 4, seconds = 6, opts = []) {
  expect(M._fe_create(SR) === 1, 'fe_create rechazado');
  M._fe_load_clear();
  freqs.forEach((f, i) => {
    const o = opts[i] ?? {};
    const p = `/t/s${i}.wav`;
    M.FS.writeFile(p, sineWav(f, o.seconds ?? seconds));
    const s = M.stringToNewUTF8(p); M._fe_load_push(s, o.loop ? 1 : 0, o.deferred ? 1 : 0); M._free(s);
  });
  M._fe_load_run(threads);
  while (M._fe_load_busy()) await new Promise((r) => setTimeout(r, 5));
  freqs.forEach((_, i) => M.FS.unlink(`/t/s${i}.wav`));
  return freqs.map((_, i) => M._fe_load_id(i));
}

// Renderiza `seconds` y devuelve el canal L
function render(seconds) {
  const frames = Math.round(SR * seconds), Q = 128, L = new Float32Array(frames);
  for (let o = 0; o < frames; o += Q) {
    const ptr = M._fe_render(Q);
    const out = new Float32Array(M.wasmMemory.buffer, ptr, Q * 2);
    for (let i = 0; i < Q && o + i < frames; i++) L[o + i] = out[2 * i];
  }
  return L;
}

// Frecuencia por cruces por cero ascendentes
function freqOf(x) {
  let c = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) c++;
  return c / (x.length / SR);
}
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

const SKIP = 'skip — falta engine/build/node: compila con `npm run engine` (necesita emsdk)';
const needEngine = async () => (await engine()) ? null : SKIP;

test('suena el seno a su frecuencia', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const [id] = await load([440]);
  M._fe_set_volume(id, 1, 1); M._fe_start();
  render(0.5); // calentar SoundTouch
  const f = freqOf(render(1));
  near(f, 440, 4, 'frecuencia');
  return `${f.toFixed(1)} Hz`;
});

test('tono +12 dobla la frecuencia', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const [id] = await load([440]);
  M._fe_set_volume(id, 1, 1); M._fe_set_pitch(id, 12); M._fe_start();
  render(0.5);
  const f = freqOf(render(1));
  near(f, 880, 9, 'frecuencia con +12');
  return `${f.toFixed(1)} Hz`;
});

test('tempo 2x avanza el doble sin cambiar tono', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const [id] = await load([440]);
  M._fe_set_volume(id, 1, 1); M._fe_set_tempo(id, 2); M._fe_start();
  render(0.5);
  const p0 = M._fe_position_ms();
  const f = freqOf(render(1));
  const adv = M._fe_position_ms() - p0;
  near(adv, 2000, 60, 'avance en 1 s');
  near(f, 440, 6, 'frecuencia a 2x');
  return `avance ${adv.toFixed(0)} ms, ${f.toFixed(1)} Hz`;
});

test('volumen escala la senal (lineal, como Android)', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const [id] = await load([440]);
  M._fe_set_volume(id, 1, 1); M._fe_start();
  render(0.5);
  const a = rms(render(0.5));
  M._fe_set_volume(id, 0.5, 0.5);
  render(0.1); // rampa
  const b = rms(render(0.5));
  near(b / a, 0.5, 0.03, 'razon de nivel');
  return `razon ${(b / a).toFixed(3)}`;
});

test('carga en paralelo: cada id es su fichero', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const freqs = [220, 330, 440, 550, 660, 770];
  const ids = await load(freqs, 4, 8); // 6 x 0.7 s renderizados: que no se acabe
  expect(new Set(ids).size === freqs.length && ids.every((i) => i >= 0), `ids: ${ids}`);
  M._fe_start();
  const got = [];
  for (let k = 0; k < freqs.length; k++) {
    ids.forEach((id, j) => M._fe_set_volume(id, j === k ? 1 : 0, j === k ? 1 : 0));
    render(0.3);
    const f = freqOf(render(0.4));
    near(f, freqs[k], 6, `stem ${k}`);
    got.push(f.toFixed(0));
  }
  return `ids ${ids.join(',')} -> ${got.join(', ')} Hz`;
});

// Stem largo (lento de decodificar) + metronomo corto: sin diferir, el corto acaba antes y es la pista 0
async function firstTrackIsMetronome(deferred) {
  const ids = await load([440, 1000], 2, 6, [{ seconds: 120 }, { seconds: 1, loop: true, deferred }]);
  return ids[1] === 0;
}

test('la pista 0 (referencia de posicion) nunca es un metronomo diferido', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  expect(await firstTrackIsMetronome(false), 'el escenario no reproduce el riesgo: sin diferir el metronomo deberia ser la pista 0');
  expect(!(await firstTrackIsMetronome(true)), 'diferido y aun asi es la pista 0');
  return 'sin diferir: metronomo = pista 0; diferido: stem = pista 0';
});

test('pista en bucle sigue sonando tras su final', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const [a, b] = await load([440, 1000], 2, 6, [{ seconds: 6 }, { seconds: 1, loop: true, deferred: true }]);
  M._fe_set_volume(a, 0, 0); M._fe_set_volume(b, 1, 1); M._fe_start();
  render(2.5); // pasada la duracion del metronomo (1 s)
  const f = freqOf(render(0.5));
  near(f, 1000, 10, 'frecuencia del bucle');
  return `${f.toFixed(0)} Hz a los 2.5 s`;
});

test('filtro: paso bajo atenua un agudo, paso alto un grave', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const level = async (freq, amount) => {
    const [id] = await load([freq]);
    M._fe_set_volume(id, 1, 1); M._fe_set_filter(id, amount); M._fe_start();
    render(0.6); // rampa del filtro
    return rms(render(0.5));
  };
  const db = (a, b) => 20 * Math.log10(a / b);
  const lp = db(await level(5000, -0.8), await level(5000, 0)); // corte 20 kHz * 0.01^0.8 = 500 Hz
  const hp = db(await level(100, 0.8), await level(100, 0));    // corte 20 Hz * 750^0.8 = 4 kHz
  expect(lp < -20 && hp < -20, `atenuacion: paso bajo ${lp.toFixed(1)} dB, paso alto ${hp.toFixed(1)} dB`);
  return `paso bajo ${lp.toFixed(1)} dB, paso alto ${hp.toFixed(1)} dB`;
});

test('eco: repite el sonido al retardo pedido', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  // 0.3 s de seno y silencio despues: con eco, a 0.3 + 0.25 s debe volver a sonar
  const n = Math.round(SR * 3), burst = Math.round(SR * 0.3);
  const buf = Buffer.from(sineWav(440, 3));
  for (let i = burst; i < n; i++) { buf.writeInt16LE(0, 44 + i * 4); buf.writeInt16LE(0, 46 + i * 4); }
  const measure = async (echo) => {
    expect(M._fe_create(SR) === 1, 'fe_create');
    M._fe_load_clear();
    M.FS.writeFile('/t/e.wav', buf);
    const s = M.stringToNewUTF8('/t/e.wav'); M._fe_load_push(s, 0, 0); M._free(s);
    M._fe_load_run(1);
    while (M._fe_load_busy()) await new Promise((r) => setTimeout(r, 5));
    M.FS.unlink('/t/e.wav');
    const id = M._fe_load_id(0);
    M._fe_set_volume(id, 1, 1); M._fe_set_echo(id, echo, 250); M._fe_start();
    const x = render(1.2);
    // Energia en 50 ms alrededor de cada instante, relativa al golpe
    const win = (t) => rms(x.subarray(Math.round(SR * t), Math.round(SR * (t + 0.05))));
    return { early: win(0.15), gap: win(0.42), echo: win(0.6) };
  };
  const dry = await measure(0), wet = await measure(0.6);
  const echoDb = 20 * Math.log10(wet.echo / wet.early), dryDb = 20 * Math.log10((dry.echo + 1e-9) / dry.early);
  expect(echoDb > -20 && dryDb < -40, `eco a 0.6 s: con eco ${echoDb.toFixed(1)} dB, sin eco ${dryDb.toFixed(1)} dB`);
  return `repeticion ${echoDb.toFixed(1)} dB (sin eco ${dryDb.toFixed(0)} dB)`;
});

test('audio 3D con HRTF: lado derecho suena a la derecha, mute 3D silencia', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const bin = path.join(ROOT, 'public/hrtf/hrtf_horizontal.bin');
  if (!fs.existsSync(bin)) return 'skip — falta public/hrtf/hrtf_horizontal.bin';
  const lr = async (az, muted = false) => {
    const [id] = await load([3000]) // agudo: diferencia interaural clara;
    M.FS.writeFile('/hrtf.bin', fs.readFileSync(bin));
    const p = M.stringToNewUTF8('/hrtf.bin'); const ok = M._fe_init_hrtf(p); M._free(p);
    expect(ok === 1, 'HRTF no cargado');
    M._fe_set_3d_enabled(id, 1); M._fe_set_3d_position(id, az, 1, 0); M._fe_set_3d_muted(id, muted ? 1 : 0); M._fe_start();
    render(0.4);
    const frames = Math.round(SR * 0.5), Q = 128; let l = 0, r = 0;
    for (let o = 0; o < frames; o += Q) {
      const out = new Float32Array(M.wasmMemory.buffer, M._fe_render(Q), Q * 2);
      for (let i = 0; i < Q; i++) { l += out[2 * i] ** 2; r += out[2 * i + 1] ** 2; }
    }
    return { l: Math.sqrt(l / frames), r: Math.sqrt(r / frames) };
  };
  const db = (a, b) => 20 * Math.log10(a / b);
  const right = await lr(Math.PI / 2), left = await lr(-Math.PI / 2), mute = await lr(Math.PI / 2, true);
  const dR = db(right.r, right.l), dL = db(left.l, left.r);
  expect(dR > 6 && dL > 6, `diferencia interaural: derecha ${dR.toFixed(1)} dB, izquierda ${dL.toFixed(1)} dB`);
  expect(mute.l + mute.r < 1e-6, `mute 3D: ${mute.l + mute.r}`);
  return `+90 grados: R ${dR.toFixed(1)} dB sobre L; -90: L ${dL.toFixed(1)} dB sobre R`;
});

test('stemGains replica el paneo de Android', async () => {
  const { stemGains } = await import(pathToFileURL(path.join(ROOT, 'src/engine/engine.ts')).href);
  const cases = [[[75, 0], [0.75, 0.75]], [[100, 50], [0.5, 1]], [[100, -50], [1, 0.5]], [[80, 100], [0, 0.8]], [[0, 30], [0, 0]]];
  for (const [[v, p], [l, r]] of cases) {
    const [gl, gr] = stemGains(v, p);
    near(gl, l, 1e-6, `L(${v},${p})`); near(gr, r, 1e-6, `R(${v},${p})`);
  }
});

test('envolvente de la pista: RMS en dBFS cada 10 ms (VocalActivity)', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const [id] = await load([440], 1, 2.5);
  const p = M._fe_envelope(id), n = M._fe_envelope_len();
  const env = new Float32Array(M.wasmMemory.buffer, p, n).slice();
  expect(n === 250, `frames: ${n}`);
  const want = 20 * Math.log10(0.3 / Math.SQRT2); // seno de amplitud 0.3
  near(env[100], want, 0.1, 'nivel del seno');
  M._fe_envelope(999);
  expect(M._fe_envelope_len() === 0, 'id fuera de rango = vacia');
  return `${n} frames, ${env[100].toFixed(2)} dBFS`;
});

test('click de downbeat: suena al cruzar el instante, atenua el metronomo y calla deshabilitado', async () => {
  { const sk = await needEngine(); if (sk) return sk; }
  const wav = fs.readFileSync(path.join(ROOT, 'public/dbclick/dbclick_stick.wav'));
  const run = async (enabled) => {
    const [music, metro] = await load([440, 1000], 2, 4);
    M._fe_set_volume(music, 0, 0); M._fe_set_volume(metro, 0.2, 0.2);
    M.FS.writeFile('/t/click.wav', wav);
    const s = M.stringToNewUTF8('/t/click.wav'); expect(M._fe_click_wav(s) === 1, 'WAV del click'); M._free(s);
    M._fe_click_enabled(enabled ? 1 : 0); M._fe_click_duck(metro); M._fe_click_at(1000);
    M._fe_start();
    return render(2);
  };
  const rms = (x, a, b) => { let e = 0; for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) e += x[i] ** 2; return Math.sqrt(e / ((b - a) * SR)); };
  const on = await run(true), off = await run(false);
  // Diferencia entre las dos pasadas = click (+ hueco del metronomo atenuado)
  let first = -1;
  for (let i = 0; i < on.length; i++) if (Math.abs(on[i] - off[i]) > 0.05) { first = i / SR; break; }
  expect(first > 0.95 && first < 1.3, `click en ${first.toFixed(3)} s`);
  expect(rms(on, 0.2, 0.9) - rms(off, 0.2, 0.9) < 1e-4, 'nada antes del instante');
  return `click/atenuacion a ${(first * 1000).toFixed(0)} ms del render (trigger 1000 ms)`;
});
