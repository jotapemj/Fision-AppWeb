// Pulso por secciones (BeatPulseMap de Android): reglas sobre la potencia por beat y senal real por el decodificador.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, expect, near } from './lib/harness.mjs';
import { sineWav } from './lib/zipWriter.mjs';
import { decode } from '../src/export/mixdown.ts';
import { BeatPulseMap, addBeatPower, drumFiles, signature } from '../src/player/beatPulseMap.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'engine/build/node/fision_export.mjs');
const beatsAt = (n, dt = 0.5) => Array.from({ length: n }, (_, i) => 0.5 + i * dt);
const db = (x) => 10 ** (x / 10);
/** Potencia por tramos: [[beats, dB], ...]. */
const powerOf = (parts) => parts.flatMap(([n, x]) => Array(n).fill(db(x)));

test('dos secciones: la tranquila no pulsa y el pulso sube en los 8 beats (+1) anteriores', () => {
  const beats = beatsAt(80), map = BeatPulseMap.fromPower(powerOf([[40, -40], [40, -20]]), beats);
  // Valores del BeatPulseMap.java real con esta misma entrada: rampa 16.5 s, seccion 21 s
  expect(map.starts.length === 1 && map.starts[0] === 21 && map.rampStarts[0] === 16.5, `seccion: ${map.rampStarts} ${map.starts}`);
  near(map.gainAt(beats[0]), 0, 1e-9, 'tranquila');
  near(map.gainAt(beats[32]), 0, 1e-9, 'inicio de la rampa');
  near(map.gainAt(beats[33]), 1 / 9, 1e-6, 'el primer beat de la rampa ya pulsa');
  near(map.gainAt(beats[41]), 1, 1e-9, 'fuerte');
  near(map.gainAt(beats[79]), 1, 1e-9, 'hasta el final');
});

test('fuerte, puente y fuerte: el puente descansa; tras la seccion, gain 0', () => {
  const beats = beatsAt(120), map = BeatPulseMap.fromPower(powerOf([[40, -15], [40, -35], [40, -15]]), beats);
  expect(map.starts.length === 2, `secciones: ${map.starts.length}`);
  near(map.gainAt(beats[10]), 1, 1e-9, 'primera');
  near(map.gainAt(beats[50]), 0, 1e-9, 'puente');
  near(map.gainAt(beats[110]), 1, 1e-9, 'ultima');
});

test('sin contraste (< 6 dB): pulsa siempre salvo donde la bateria calla', () => {
  const beats = beatsAt(80);
  const flat = BeatPulseMap.fromPower(powerOf([[40, -20], [40, -18]]), beats);
  expect([0, 40, 79].every((i) => flat.gainAt(beats[i]) === 1), 'sin contraste, todo');
  const gap = BeatPulseMap.fromPower(powerOf([[30, -20], [20, -90], [30, -20]]), beats);
  expect(gap.gainAt(beats[10]) === 1 && gap.gainAt(beats[40]) === 0 && gap.gainAt(beats[70]) === 1, `silencio: ${gap.gainAt(beats[40])}`);
});

test('paridad con BeatPulseMap.java (javac del JBR, 2026-11-04): varias secciones', () => {
  const parts = [[20, -30], [20, -22], [30, -12], [20, -40], [30, -12]], p = powerOf(parts), m = BeatPulseMap.fromPower(p, p.map((_, i) => 0.5 + i * 0.5));
  const got = `${m.rampStarts} | ${m.starts} | ${m.ends}`;
  expect(got === '15,42 | 19.5,46.5 | 35,120', got);
});

test('secciones de menos de 16 beats se absorben; sin bateria (< -50 dB) pulsa siempre', () => {
  const beats = beatsAt(90);
  const blip = BeatPulseMap.fromPower(powerOf([[40, -15], [10, -35], [40, -15]]), beats);
  expect(blip.gainAt(beats[45]) === 1, `hueco corto: ${blip.gainAt(beats[45])}`);
  const none = BeatPulseMap.fromPower(powerOf([[90, -80]]), beats);
  expect(none.starts[0] === 0 && none.gainAt(0) === 1 && none.gainAt(beats[89]) === 1, 'sin bateria');
});

test('cache: ida y vuelta con 3 decimales; firma distinta u otro formato = medir otra vez', () => {
  const beats = beatsAt(80), map = BeatPulseMap.fromPower(powerOf([[40, -40], [40, -20]]), beats);
  const txt = map.serialize('sig');
  expect(txt.split('\n')[0] === '1 sig' && /^\d+\.\d{3} \d+\.\d{3} \d+\.\d{3}$/.test(txt.split('\n')[1]), `formato: ${txt}`);
  const back = BeatPulseMap.parse(txt, 'sig');
  near(back.gainAt(beats[33]), 1 / 9, 1e-3, 'misma ganancia');
  expect(BeatPulseMap.parse(txt, 'otra') === null && BeatPulseMap.parse('', 'sig') === null && BeatPulseMap.parse('1 sig\nroto', 'sig') === null && BeatPulseMap.parse('1 sig\n', 'sig') === null, 'cache invalida');
});

test('bateria: entera o sus partes + perc; flac antes que wav; firma con tamano y fecha', () => {
  expect(drumFiles(['bass.flac', 'drums.flac', 'kick.flac', 'perc.flac']).join() === 'drums.flac', 'entera');
  expect(drumFiles(['snare.wav', 'kick.flac', 'kick.wav', 'perc.flac', 'bass.flac']).join() === 'kick.flac,snare.wav,perc.flac', 'partes');
  expect(drumFiles(['bass.flac', 'vocals.flac']).length === 0, 'sin bateria');
  expect(signature([{ size: 10, lastModified: 20 }, { size: 30, lastModified: 40 }], 80) === '80_10_20_30_40', 'firma');
});

test('potencia por beat: media de la ventana, la ultima hasta el final, antes del primer beat no cuenta', () => {
  const sr = 10, data = new Float32Array(40); // mono, 4 s
  data.fill(1, 0, 10); data.fill(0.5, 10, 30); data.fill(0.25, 30, 40);
  const power = new Float64Array([1, 1]); // se suma a lo que hubiera
  addBeatPower({ data, sr, ch: 1, frames: 40 }, [1, 3], power);
  near(power[0], 1 + 0.25, 1e-9, 'ventana 1..3 s');
  near(power[1], 1 + 0.0625, 1e-9, 'ultima ventana, hasta el final');
  // Estereo: mono = media de canales
  const st = new Float64Array(1);
  addBeatPower({ data: new Float32Array([1, 0, 1, 0]), sr: 10, ch: 2, frames: 2 }, [0], st);
  near(st[0], 0.25, 1e-9, 'estereo');
});

test('senal real: WAV con 10 s flojos y 10 s fuertes por el decodificador del motor', async () => {
  if (!fs.existsSync(BUILD)) return 'skip — falta engine/build/node/fision_export.mjs: `bash engine/build.sh export`';
  const { default: create } = await import(pathToFileURL(BUILD).href);
  const M = await create({ printErr: () => {} });
  const wav = sineWav(60, 20);
  for (let i = 44; i < 44 + 10 * 48000 * 4; i += 2) wav.writeInt16LE(Math.round(wav.readInt16LE(i) * 0.1), i); // -20 dB
  const beats = beatsAt(39), power = new Float64Array(beats.length);
  addBeatPower(decode(M, 'kick.wav', new Uint8Array(wav)), beats, power);
  near(10 * Math.log10(power[30] / power[5]), 20, 0.5, 'la potencia ve los -20 dB');
  const map = BeatPulseMap.fromPower(power, beats);
  expect(map.gainAt(2) === 0 && map.gainAt(15) === 1, `flojo ${map.gainAt(2)}, fuerte ${map.gainAt(15)}`);
  near(map.starts[0], 10, 0.51, 'empieza con la parte fuerte');
  return `seccion fuerte desde ${map.starts[0]} s, rampa desde ${map.rampStarts[0]} s`;
});
