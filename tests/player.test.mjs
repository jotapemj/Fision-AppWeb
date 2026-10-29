// Reglas del reproductor (app_spec §3) contra un motor falso que apunta las llamadas.
import { test, expect, near } from './lib/harness.mjs';
import { Player, Repeat, parseBpm, parseBeats, localBeatIntervalMs } from '../src/player/player.ts';

function fakeEngine() {
  const e = { pos: 0, vol: {}, pitch: {}, solo: {}, tempo: 1, played: 0, paused: 0,
    ctx: { outputLatency: 0.04, baseLatency: 0.02 },
    get positionMs() { return e.pos; },
    setVolume(id, v, pan = 0) { e.vol[id] = [v, pan]; },
    setPitch(id, s) { e.pitch[id] = s; },
    setTempo(m) { e.tempo = m; },
    setSoloMuted(id, m) { e.solo[id] = m; },
    seek(ms) { e.pos = ms; },
    trackSeeks: [],
    seekTrack(id, ms) { e.trackSeeks.push([id, ms]); },
    async play() { e.played++; },
    pause() { e.paused++; } };
  return e;
}
const names = ['bass.flac', 'kick.flac', 'vocals.flac', 'metronome.flac', 'vocals2.flac', 'perc.flac', 'guitar.flac', 'metronome_half.flac', 'metronome_double.flac'];
const song = (bpm = 176.47, beats = [0.5, 1.0, 1.5, 2.1, 2.8]) => ({ stems: names.map((name, id) => ({ name, id, decodeMs: 1 })), durationMs: 200_000, bpm, beats });
const idOf = (p, stem) => p.stems.find((s) => s.stem === stem).id;

test('orden StemSpec, metronomo aparte y mudo, todo a 75', () => {
  const e = fakeEngine(), p = new Player(e, song());
  expect(p.stems.map((s) => s.stem).join() === 'vocals,vocals2,bass,guitar,perc,kick', p.stems.map((s) => s.stem).join());
  expect(p.metronomeIds.metronome === 3 && e.vol[3][0] === 0, 'metronomo');
  expect(p.stems.every((s) => e.vol[s.id][0] === 75), 'volumen inicial');
});

test('tono: bateria y percusion no se transponen', () => {
  const e = fakeEngine(), p = new Player(e, song());
  p.setPitch(5);
  for (const s of p.stems) {
    const want = ['kick', 'perc'].includes(s.stem) ? 0 : 5;
    expect(e.pitch[s.id] === want, `${s.stem}: ${e.pitch[s.id]}`);
  }
  p.setPitch(40);
  expect(p.pitch === 12, `limite ${p.pitch}`);
});

test('tempo en BPM: mult = objetivo / global, limites 50..200', () => {
  const e = fakeEngine(), p = new Player(e, song(176.47));
  p.setTempoBpm(150);
  near(e.tempo, 150 / 176.47, 1e-9, 'mult');
  expect(p.targetBpm === 150, `bpm ${p.targetBpm}`);
  p.setTempoBpm(500);
  expect(p.targetBpm === 200, `tope ${p.targetBpm}`);
  const q = new Player(fakeEngine(), song(null));
  q.setTempoMult(1.13);
  near(q.tempoMult, 1.15, 1e-9, 'sin BPM: pasos de 0.05');
});

test('mute = 0 y vuelve al ultimo volumen; solo multiple', () => {
  const e = fakeEngine(), p = new Player(e, song());
  p.setVolume('bass', 60);
  p.toggleMute('bass');
  expect(e.vol[idOf(p, 'bass')][0] === 0, 'mute');
  p.toggleMute('bass');
  expect(e.vol[idOf(p, 'bass')][0] === 60, `quitar mute: ${e.vol[idOf(p, 'bass')][0]}`);
  p.toggleSolo('vocals'); p.toggleSolo('bass');
  const gated = p.stems.filter((s) => e.solo[s.id]).map((s) => s.stem).sort().join();
  expect(gated === 'guitar,kick,perc,vocals2', `silenciados: ${gated}`);
  p.toggleSolo('vocals'); p.toggleSolo('bass');
  expect(p.stems.every((s) => !e.solo[s.id]), 'sin solo, nadie silenciado');
});

test('fin de cancion: Off para, All repite, One repite una vez', () => {
  const e = fakeEngine(), p = new Player(e, song());
  p.playing = true;
  e.pos = 199_760; // umbral: duracion - 250
  expect(p.checkEnd() === 'stopped' && e.pos === 0 && !p.playing, 'Off');
  p.repeat = Repeat.All; p.playing = true; e.pos = 199_800;
  expect(p.checkEnd() === 'looped' && e.pos === 0 && p.playing, 'All');
  p.repeat = Repeat.One; e.pos = 199_800;
  expect(p.checkEnd() === 'looped', 'One 1a vez');
  e.pos = 199_800;
  expect(p.checkEnd() === 'stopped', 'One 2a vez');
  p.playing = true; e.pos = 100_000;
  expect(p.checkEnd() === null, 'a mitad no hace nada');
  p.repeat = Repeat.Off; p.autoplayNext = true; e.pos = 199_900;
  expect(p.checkEnd() === 'next', 'autoplay');
});

test('BPM de beats.txt y posicion percibida', () => {
  near(parseBpm('176.47058823529235\n0.1\n'), 176.47, 0.01, 'bpm');
  expect(parseBpm('') === null && parseBpm(null) === null && parseBpm('abc') === null, 'sin bpm');
  const e = fakeEngine(), p = new Player(e, song());
  e.pos = 10_000; p.playing = true;
  near(p.positionMs, 10_000 - 40 - 130, 1e-9, 'percibida');
});

test('metronomo: solo suena el elegido, a su volumen', () => {
  const e = fakeEngine(), p = new Player(e, song());
  const [half, one, dbl] = [7, 3, 8];
  expect([half, one, dbl].every((id) => e.vol[id][0] === 0), 'mudos al abrir');
  p.setMetronome(true);
  expect(e.vol[one][0] === 100 && e.vol[half][0] === 0 && e.vol[dbl][0] === 0, '1x por defecto a 100');
  p.setMetronome(true, 2, 60);
  expect(e.vol[dbl][0] === 60 && e.vol[one][0] === 0, '2x a 60');
  p.setMetronome(false);
  expect([half, one, dbl].every((id) => e.vol[id][0] === 0), 'apagado');
});

test('0.5x variante B: pista half adelantada un beat local, reaplicado en cada seek', () => {
  const e = fakeEngine(), p = new Player(e, song());
  p.seek(1200);
  expect(JSON.stringify(e.trackSeeks.at(-1)) === '[7,1200]', `A sin desfase: ${e.trackSeeks.at(-1)}`);
  p.setHalfVariantB(true);
  p.seek(2500); // entre 2.1 y 2.8 -> 700 ms
  expect(JSON.stringify(e.trackSeeks.at(-1)) === '[7,3200]', `B: ${e.trackSeeks.at(-1)}`);
  expect(localBeatIntervalMs([0.5, 1.0], 9000, null) === 500, 'pasado el final: ultimo intervalo');
  expect(localBeatIntervalMs([], 0, 120) === 500 && localBeatIntervalMs([], 0, null) === 500, 'sin beats: BPM global o 500');
  expect(parseBeats(['120', '0.5', '1.0', ''].join('\n')).join() === '0.5,1', 'parseBeats');
});

test('mezcla guardada: ida y vuelta, solo lo no default, el solo no se guarda', async () => {
  const { capture, restore } = await import('../src/player/songParams.ts');
  const e = fakeEngine(), p = new Player(e, song());
  let changes = 0;
  p.onChange = () => changes++;
  p.setVolume('bass', 40); p.stems.find((s) => s.stem === 'guitar').pan = -30; p.setVolume('guitar', 75);
  p.setPitch(-3); p.setTempoBpm(150); p.setMetronome(true, 0, 60); p.setHalfVariantB(true); p.toggleSolo('vocals');
  expect(changes >= 6, `avisos de cambio: ${changes}`);
  const saved = JSON.parse(JSON.stringify(capture(p)));
  expect(JSON.stringify(saved.stems) === JSON.stringify({ bass: { v: 40 }, guitar: { p: -30 } }), `stems: ${JSON.stringify(saved.stems)}`);
  const e2 = fakeEngine(), q = new Player(e2, song());
  restore(q, saved);
  const g = q.stems.find((s) => s.stem === 'guitar');
  expect(e2.vol[q.stems.find((s) => s.stem === 'bass').id][0] === 40 && e2.vol[g.id][1] === -30, 'volumen y paneo al motor');
  expect(q.pitch === -3 && q.targetBpm === 150 && q.metroOn && q.metroSpeed === 0 && q.metroVolume === 60 && q.metroHalfB, 'tono, tempo, metronomo');
  expect(q.stems.every((s) => !s.solo), 'el solo no se guarda');
  restore(new Player(fakeEngine(), song()), { stems: { bass: { v: 'x' } }, pitch: null, metroSpeed: 7 }); // basura: no revienta
});
