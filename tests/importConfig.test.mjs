// Subir y reprocesar sin red: config_json rico, presets -> personalizada, prefill y errores por codigo.
import { test, expect } from './lib/harness.mjs';
import { newSep, isSelected, tapTile, tapVariant, buildConfig, sepFromConfig, checkFile, uploadErrorKey, reprocessErrorKey, jobErrorKey, fileMeta, restKey } from '../src/library/importConfig.ts';

test('presets clasicos y device por GPU; acordes siempre btc', () => {
  const s = newSep();
  const a = JSON.stringify(buildConfig(s, true));
  s.mode = '2stem';
  const b = JSON.stringify(buildConfig(s, false));
  expect(a === '{"sep":{"mode":"classic","preset":"4stem","sep_mode":4},"device":"cuda","chords":"btc"}', a);
  expect(b === '{"sep":{"mode":"classic","preset":"2stem","sep_mode":2},"device":"cpu","chords":"btc"}' && restKey(s) === 'title_accompaniment', b);
});

test('tocar un tile en un preset pasa a personalizada desde sus stems; variantes; voces bloqueadas', () => {
  const s = newSep();
  tapTile(s, 'vocals');
  expect(s.mode === '4stem', 'voces no se tocan');
  tapTile(s, 'guitar');
  expect(s.mode === 'custom' && ['vocals', 'bass', 'drums', 'guitar'].every((x) => isSelected(s, x)) && !isSelected(s, 'piano'), [...s.custom].join());
  tapTile(s, 'bass');
  tapVariant(s, 'drums', true); tapVariant(s, 'vocals', true); tapTile(s, 'winds');
  const c = buildConfig(s, true).sep;
  expect(JSON.stringify(c) === '{"mode":"personalized","vocals":"split","stems":{"guitar":{"enabled":true},"bass":{"enabled":false},"drums":{"enabled":true,"variant":"split"},"piano":{"enabled":false},"brass":{"enabled":true}}}', JSON.stringify(c));
  // Variante igual a la que ya se ve en un preset: sigue siendo preset
  const p = newSep(); tapVariant(p, 'drums', false);
  expect(p.mode === '4stem', 'variante igual no cambia el preset');
  // Ida y vuelta por el config guardado
  const back = sepFromConfig(buildConfig(s, true));
  expect(back.mode === 'custom' && back.vocalsSplit && back.drumsSplit && back.custom.has('winds') && !back.custom.has('bass'), 'prefill');
  expect(sepFromConfig({ sep: { mode: 'classic', sep_mode: 2 } }).mode === '2stem' && sepFromConfig(null).mode === '4stem', 'prefill clasico / sin config');
});

test('comprobaciones antes de subir y textos por estado y codigo', () => {
  const k = [checkFile('a.txt', 10, 60), checkFile('a.MP3', 0, null), checkFile('a.flac', 300 * 1024 * 1024, 60), checkFile('a.ogg', 1000, 9), checkFile('a.wav', 1000, null)];
  expect(JSON.stringify(k) === JSON.stringify([['import_err_unsupported_format'], ['import_err_empty'], ['import_err_too_large'], ['import_err_too_short', 15], null]), JSON.stringify(k));
  const u = [uploadErrorKey(415, 'x'), uploadErrorKey(400, 'audio_too_short'), uploadErrorKey(400, 'weird'), uploadErrorKey(429, 'job_limit'), uploadErrorKey(502, 'http_502')];
  expect(JSON.stringify(u) === JSON.stringify([['import_err_unsupported_format'], ['import_err_too_short', 15], ['import_err_internal'], ['err_job_limit'], ['web_upload_failed_status', 502]]), JSON.stringify(u));
  expect(reprocessErrorKey(409)[0] === 'reprocess_busy' && reprocessErrorKey(404)[0] === 'reprocess_missing_input' && jobErrorKey('gpu_busy') === 'job_err_gpu_busy' && jobErrorKey('nuevo') === 'cloud_state_error', 'reproceso y job');
  expect(fileMeta('x.flac', 43 * 1024 * 1024, 355) === '5:55 · FLAC · 43.0 MB' && fileMeta('x.mp3', 1048576, null) === 'MP3 · 1.0 MB', fileMeta('x.flac', 43 * 1024 * 1024, 355));
});
