// Reglas del reproductor (app_spec §3) contra un motor falso que apunta las llamadas.
import { test, expect, near } from './lib/harness.mjs';
import { Player, Repeat, parseBpm, parseBeats, localBeatIntervalMs, filterCutoffHz, windowBpm, localBpmAt } from '../src/player/player.ts';

test('BPM local: rotulo con media de 6 intervalos y tempo de esta parte (PlayerActivity)', () => {
  // 120 BPM los 8 primeros beats, luego 150 (0.4 s)
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 3.9, 4.3, 4.7, 5.1, 5.5, 5.9];
  expect(windowBpm(beats, 0) === null && windowBpm([1], 3) === null, 'sin intervalo: no cambia');
  expect(windowBpm(beats, 1) === 120 && windowBpm(beats, 6) === 120, `inicio: ${windowBpm(beats, 6)}`);
  expect(windowBpm(beats, 10) === 133, `mezcla de tempos (6 intervalos de 2 a 4.7 s): ${windowBpm(beats, 10)}`);
  expect(windowBpm(beats, 13) === 150 && windowBpm(beats, 99) === 150, `final: ${windowBpm(beats, 13)}`);
  expect(localBpmAt(beats, 1.2, 167) === 120 && localBpmAt(beats, 4.0, 167) === 150, 'por intervalo al beat siguiente');
  expect(localBpmAt(beats, -1, 167) === 167 && localBpmAt(beats, 9, 167) === 167, 'fuera de los beats: global');
  expect(localBpmAt([], 1, null) === 0 && localBpmAt([], 1, 99.6) === 100, 'sin beats: global o 0');
});

function fakeEngine() {
  const e = { pos: 0, vol: {}, pitch: {}, solo: {}, tempo: 1, played: 0, paused: 0,
    ctx: { outputLatency: 0.04, baseLatency: 0.02 },
    get positionMs() { return e.pos; },
    setVolume(id, v, pan = 0) { e.vol[id] = [v, pan]; },
    setPitch(id, s) { e.pitch[id] = s; },
    setTempo(m) { e.tempo = m; },
    setSoloMuted(id, m) { e.solo[id] = m; },
    fx: {},
    setFilter(id, a) { (e.fx[id] ??= {}).filter = a; },
    setEcho(id, a, d) { Object.assign(e.fx[id] ??= {}, { echo: a, delay: d }); },
    setReverb(id, s, r) { Object.assign(e.fx[id] ??= {}, { reverb: s, room: r }); },
    seek(ms) { e.pos = ms; },
    d3: {}, set3DEnabled(id, on) { (e.d3[id] ??= {}).on = on; }, set3DPosition(id, az, dist, elev) { Object.assign(e.d3[id] ??= {}, { az, dist, elev }); },
    set3DOmni(id, on) { (e.d3[id] ??= {}).omni = on; }, set3DMuted(id, on) { (e.d3[id] ??= {}).muted = on; },
    trackSeeks: [],
    seekTrack(id, ms) { e.trackSeeks.push([id, ms]); },
    clicks: [], clickOn: false, clickDuck: -1, clickWav: 0,
    setClickWav() { e.clickWav++; return true; }, clickAt(ms) { e.clicks.push(ms); }, clearClicks() { e.clicks = []; },
    setClickEnabled(on) { e.clickOn = on; }, setClickDuck(id) { e.clickDuck = id; },
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

test('FX: zona muerta del filtro, retardo del eco por BPM, paneo guardado y FX no', async () => {
  const { capture } = await import('../src/player/songParams.ts');
  const e = fakeEngine(), p = new Player(e, song(120));
  const g = p.stems.find((s) => s.stem === 'guitar');
  p.setFx('guitar', { filter: 0.02 });
  expect(e.fx[g.id].filter === 0, `zona muerta: ${e.fx[g.id].filter}`);
  p.setFx('guitar', { filter: -0.5, echo: 0.4, echoDivision: 3, reverb: 0.3, room: 2 });
  expect(e.fx[g.id].filter === -0.5 && e.fx[g.id].delay === 250 && e.fx[g.id].room === 2, JSON.stringify(e.fx[g.id])); // 1/8 a 120 BPM
  const q = new Player(fakeEngine(), song(null));
  q.setFx('guitar', { echo: 0.5, echoDivision: 2 });
  expect(Math.abs(q.stems.find((s) => s.stem === 'guitar').fx.echo - 0.5) < 1e-9, 'eco');
  p.setPan('guitar', -40);
  expect(e.vol[g.id][1] === -40, 'paneo al motor');
  const saved = capture(p);
  expect(saved.stems.guitar.p === -40 && !('fx' in saved) && !JSON.stringify(saved).includes('reverb'), `guardado: ${JSON.stringify(saved)}`);
  expect(Math.round(filterCutoffHz(-1)) === 200 && Math.round(filterCutoffHz(1)) === 15000 && Math.round(filterCutoffHz(-0.8)) === 502, 'cortes');
});

const close = (a, b, tol) => Math.abs(a - b) <= tol;

test('3D: semicirculo frontal, esfericas al motor, al apagar vuelven volumen y balance', async () => {
  const { worldPos, azOfWorld, H_MAX_M } = await import('../src/player/audio3d.ts');
  const e = fakeEngine(), p = new Player(e, song());
  const az = p.stems.map((s) => p.poses.get(s.stem).az);
  expect(close(az[0], -Math.PI / 2, 1e-9) && close(az.at(-1), Math.PI / 2, 1e-9), `semicirculo: ${az.map((a) => a.toFixed(2))}`);
  p.setPan('guitar', 50);
  p.set3DEnabled(true);
  const g = idOf(p, 'guitar');
  expect(e.d3[g].on && e.d3[g].dist === 1.5 && e.d3[g].elev === 0, JSON.stringify(e.d3[g]));
  // Altura 1.5 a radio 1.5: elevacion 45 grados y distancia real 1.5*raiz(2)
  p.setPose('guitar', { h: 1.5, az: Math.PI / 2, placed: true });
  expect(close(e.d3[g].elev, 45, 1e-6) && close(e.d3[g].dist, 1.5 * Math.SQRT2, 1e-6), JSON.stringify(e.d3[g]));
  // Oido derecho en -X (la camara empieza detras): la ida y vuelta conserva el azimut
  const w = worldPos({ az: Math.PI / 2, h: 0, rh: 1 });
  expect(close(w.x, -1, 1e-9) && close(azOfWorld(w.x, w.z), Math.PI / 2, 1e-9), `mundo: ${JSON.stringify(w)}`);
  p.setPose('guitar', { muted: true, omni: true });
  expect(e.d3[g].muted && e.d3[g].omni, 'mute y omni al motor');
  p.set3DEnabled(false);
  expect(!e.d3[g].on && e.vol[g][1] === 50, 'balance de vuelta');
  expect(H_MAX_M > 2 && H_MAX_M < 2.1, `techo: ${H_MAX_M}`);
});

test('3D guardado: x/y en convencion motor, ida y vuelta, sin tocar = sin claves', async () => {
  const { capture, restore } = await import('../src/player/songParams.ts');
  const e = fakeEngine(), p = new Player(e, song());
  expect(JSON.stringify(capture(p).stems) === '{}', `sin tocar: ${JSON.stringify(capture(p).stems)}`);
  p.setPose('bass', { az: Math.PI / 2, h: 0.75, rh: 0.75, placed: true });
  p.setPose('kick', { muted: true });
  p.set3DEnabled(true);
  const saved = JSON.parse(JSON.stringify(capture(p)));
  const b = saved.stems.bass;
  expect(close(b.x, 1, 1e-9) && close(b.y, 0, 1e-9) && close(b.e, 45, 1e-9) && b.d === 0.75 && saved.stems.kick.m === true && saved.audio3d === true, JSON.stringify(saved.stems));
  const e2 = fakeEngine(), q = new Player(e2, song());
  restore(q, saved);
  const qb = q.poses.get('bass'), bid = idOf(q, 'bass');
  expect(q.audio3d && close(qb.az, Math.PI / 2, 1e-9) && close(qb.h, 0.75, 1e-9) && e2.d3[bid].on && e2.d3[idOf(q, 'kick')].muted, JSON.stringify(qb));
  // Datos de Android: solo e sin x/y = hueco del semicirculo con esa elevacion
  restore(q, { stems: { vocals: { e: 10 } } });
  expect(!q.poses.get('vocals').placed && q.poses.get('vocals').h > 0.2, 'elevacion sin posicion');
});

test('baile: orbita a su velocidad, swing 0.6 sin(fase), el agarrado no se mueve', async () => {
  const { Dance, defaultPose } = await import('../src/player/audio3d.ts');
  const poses = new Map([['a', defaultPose(0, 2)], ['b', defaultPose(1, 2)]]);
  const d = new Dance();
  d.distance = 2; d.speed = 0.25; d.setHz('a', 1);
  const r = [0.5, 0, 0.5]; let k = 0; // factor 1.0 para a; 0.7 para b
  d.start(poses, ['a', 'b'], ['a'], false, () => r[k++ % r.length]);
  expect(poses.get('a').rh === 2 && poses.get('b').rh === 2, 'distancia del baile');
  const a0 = poses.get('a').az;
  d.tick(0.25, poses);
  // 0.25 vueltas/s x 0.25 s = 1/16 de vuelta; el motor gira al contrario que la escena
  expect(close(poses.get('a').az, a0 - Math.PI / 8, 1e-9), `orbita: ${poses.get('a').az - a0}`);
  expect(close(poses.get('a').h, 0.6, 1e-9) && poses.get('b').h === 0, `swing: ${poses.get('a').h}`);
  const bz = poses.get('b').az;
  d.tick(0.1, poses, 'b');
  expect(poses.get('b').az === bz, 'agarrado quieto');
  d.stop();
  expect(d.tick(1, poses).length === 0, 'parado');
});

test('seek en pausa: la posicion es el destino aunque el motor aun no lo aplique', () => {
  const e = fakeEngine(), p = new Player(e, song());
  e.seek = (ms) => { e.pending = ms; }; // como el motor real: se aplica al renderizar
  e.pos = 5000;
  p.seek(13_000);
  expect(p.positionMs === 13_000, `pausa: ${p.positionMs}`);
  p.skip(5000);
  expect(p.positionMs === 18_000, `+5 s desde el destino: ${p.positionMs}`);
  p.playing = true;
  expect(p.positionMs === 18_000, 'sonando, aun sin aplicar: destino');
  e.pos = 18_010; // el motor llego
  near(p.positionMs, 18_010 - 40 - 130, 1e-9, 'llego: posicion percibida normal');
});

test('vista plana: distancia = |x, y| (min 0.1) y elevacion del slider; se guarda el modulo; la escena guarda unitario', async () => {
  const { capture, restore } = await import('../src/player/songParams.ts');
  const { heightForElev } = await import('../src/player/audio3d.ts');
  const e = fakeEngine(), p = new Player(e, song());
  p.setFlat3D(true);
  p.set3DEnabled(true);
  const g = idOf(p, 'guitar');
  expect(e.d3[g].dist === 1 && e.d3[g].elev === 0, `semicirculo plano: ${JSON.stringify(e.d3[g])}`);
  p.setPose('guitar', { az: Math.PI / 2, fr: 0.5, placed: true });
  expect(close(e.d3[g].az, Math.PI / 2, 1e-9) && e.d3[g].dist === 0.5, JSON.stringify(e.d3[g]));
  p.setPose('guitar', { fr: 0.02 });
  expect(e.d3[g].dist === 0.1, `minimo 0.1: ${e.d3[g].dist}`);
  // Elevacion del slider (-30..70): la pose guarda la altura con su radio de escena
  p.setPose('guitar', { fr: 0.5, h: heightForElev(p.poses.get('guitar'), 40) });
  expect(close(e.d3[g].elev, 40, 1e-6), `elevacion ${e.d3[g].elev}`);
  p.setPose('guitar', { h: heightForElev(p.poses.get('guitar'), 85) });
  expect(close(e.d3[g].elev, 70, 1e-6), `tope 70: ${e.d3[g].elev}`);
  const saved = JSON.parse(JSON.stringify(capture(p))).stems.guitar;
  expect(close(Math.hypot(saved.x, saved.y), 0.5, 1e-9), `modulo guardado: ${JSON.stringify(saved)}`);
  const q = new Player(fakeEngine(), song());
  restore(q, { stems: { guitar: saved } });
  expect(close(q.poses.get('guitar').fr, 0.5, 1e-9), 'ida y vuelta');
  // Escena: la misma pose da la distancia esferica (fr no cuenta)
  p.setFlat3D(false);
  expect(close(e.d3[g].dist, p.poses.get('guitar').rh / Math.cos(e.d3[g].elev * Math.PI / 180), 1e-6), `escena: ${e.d3[g].dist}`);
});

test('click de downbeat: solo con metronomo, cola desde la posicion, pausa la vacia, duck al metronomo elegido', async () => {
  const e = fakeEngine(), p = new Player(e, song());
  p.setDownbeats([0.5, 2.1, 4.0]);
  p.setDownbeatSound(true, new Uint8Array(4));
  expect(e.clickWav === 1 && !e.clickOn && e.clicks.length === 0, 'sin metronomo no suena');
  p.setMetronome(true, 2);
  expect(e.clickOn && e.clickDuck === 8 && e.clicks.join() === '500,2100,4000', `cola ${e.clicks} duck ${e.clickDuck}`);
  p.seek(2100);
  expect(e.clicks.join() === '4000', `tras seek: ${e.clicks}`);
  p.pause();
  expect(e.clicks.length === 0, 'pausa = cancelPendingDownbeats');
  await p.play();
  expect(e.clicks.join() === '4000', `al reanudar: ${e.clicks}`);
  p.setDownbeatSound(false);
  expect(!e.clickOn && e.clickDuck === -1 && e.clicks.length === 0, 'apagado');
});
