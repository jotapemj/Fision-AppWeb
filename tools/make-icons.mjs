// Iconos de la PWA = icono adaptativo de Android (ic_launcher_bg + ic_launcher_fg), pintados en Chrome sin ventana.
// Uso: node tools/make-icons.mjs <ruta a res/drawable-xxxhdpi/ic_launcher_fg.png>
import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../tests/lib/chrome.mjs';

const fgPath = process.argv[2];
if (!fgPath || !fs.existsSync(fgPath)) { console.error('uso: node tools/make-icons.mjs <ic_launcher_fg.png>'); process.exit(1); }
const out = path.resolve('public/icons');
fs.mkdirSync(out, { recursive: true });

// [fichero, lado, recorte] : 'full' = cuadrado a sangre (maskable / iOS), 'round' = circulo (ic_launcher_round)
const ICONS = [
  ['maskable-512.png', 512, 'full'], ['maskable-192.png', 192, 'full'], ['apple-touch-icon.png', 180, 'full'],
  ['icon-512.png', 512, 'round'], ['icon-192.png', 192, 'round'], ['favicon-48.png', 48, 'round'],
];

const page = await launch({ width: 600, height: 600 });
try {
  const fg = `data:image/png;base64,${fs.readFileSync(fgPath).toString('base64')}`;
  for (const [file, size, clip] of ICONS) {
    const url = await page.eval(`(async () => {
      const s = ${size}, c = document.createElement('canvas'); c.width = c.height = s;
      const g = c.getContext('2d'), u = s / 108; // unidades del vector de Android (108 dp)
      if (${clip === 'round'}) { g.beginPath(); g.arc(s / 2, s / 2, s / 2, 0, 2 * Math.PI); g.clip(); }
      // ic_launcher_bg: foco radial de acento oscuro hasta negro
      const r = g.createRadialGradient(46.913 * u, 54 * u, 0, 46.913 * u, 54 * u, 72 * u);
      [[0, '#17604F'], [0.28, '#0C3A30'], [0.58, '#03130F'], [0.82, '#000'], [1, '#000']].forEach(([o, col]) => r.addColorStop(o, col));
      g.fillStyle = r; g.fillRect(0, 0, s, s);
      const im = new Image(); im.src = ${JSON.stringify(fg)}; await im.decode();
      g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, s, s);
      return c.toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(out, file), Buffer.from(url.split(',')[1], 'base64'));
    console.log(file, size);
  }
} finally { await page.close(); }
