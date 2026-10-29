// Reglas del reproductor (app_spec §3) contra un motor falso que apunta las llamadas.
import { test, expect, near } from './lib/harness.mjs';
import { Player, Repeat, parseBpm } from '../src/player/player.ts';

function fakeEngine() {
  const e = { pos: 0, vol: {}, pitch: {}, solo: {}, tempo: 1, played: 0, paused: 0,
    ctx: { outputLatency: 0.04, baseLatency: 0.02 },
    get positionMs() { return e.pos; },
    setVolume(id, v, pan = 0) { e.vol[id] = [v, pan]; },
    setPitch(id, s) { e.pitch[id] = s; },
    setTempo(m) { e.tempo = m; },
    setSoloMuted(id, m) { e.solo[id] = m; },
    seek(ms) { e.pos = ms; },
    async play() { e.played++; },
    pause() { e.paused++; } };
  return e;
}
const names = ['bass.flac', 'kick.flac', 'vocals.flac', 'metronome.flac', 'vocals2.flac', 'perc.flac', 'guitar.flac'];
const song = (bpm = 176.47) => ({ stems: names.map((name, id) => ({ name, id, decodeMs: 1 })), durationMs: 200_000, bpm });
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
