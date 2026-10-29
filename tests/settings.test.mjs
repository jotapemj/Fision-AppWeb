// Ajustes: defaults de Android, persistencia y saneado de lo guardado.
import { test, expect } from './lib/harness.mjs';
import { SettingsStore, DEFAULTS } from '../src/settings.ts';

const mem = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };

test('defaults = los de Android (todo apagado, acento verde, recientes primero)', () => {
  const s = new SettingsStore(mem());
  expect(JSON.stringify(s.all()) === JSON.stringify(DEFAULTS), JSON.stringify(s.all()));
  expect(!s.get('nebula') && !s.get('songColors') && s.get('accentId') === 0 && !s.get('sortAsc'), 'defaults');
});

test('guarda, avisa y vuelve a leer; basura guardada = default', () => {
  const st = mem();
  const s = new SettingsStore(st);
  const seen = [];
  s.subscribe((_, k) => seen.push(k));
  s.set('accentId', 2); s.set('chordLatin', true); s.set('chordLatin', true);
  expect(seen.join() === 'accentId,chordLatin', `avisos: ${seen}`);
  const again = new SettingsStore(st);
  expect(again.get('accentId') === 2 && again.get('chordLatin'), 'persistido');
  const bad = new SettingsStore(mem({ 'fision.settings': '{"accentId":9,"nebula":"si","lang":3,"otra":1}' }));
  expect(bad.get('accentId') === 0 && bad.get('nebula') === false && bad.get('lang') === '' && !('otra' in bad.all()), JSON.stringify(bad.all()));
  expect(new SettingsStore(mem({ 'fision.settings': '{roto' })).get('accentId') === 0, 'json roto');
});
