// Worker del export: render offline (fision_export.wasm) + WAV o M4A. Fuera del hilo de la UI;
// cancelar = terminar el Worker (nada a medias llega a la carpeta: se escribe al recibir cada fichero).
import { fxIsActive, mixdown, renderStem, wavPcm16, type ExportModule, type Rendered } from './mixdown.ts';
import { encodeM4a } from './m4a.ts';
import type { ExportJob, FromWorker, ToWorker } from './job.ts';

let mod: Promise<ExportModule> | null = null;
// import() sin que Vite lo reescriba (el glue vive en public/)
const load = (glue: string) => (mod ??= (new Function('u', 'return import(u)') as (u: string) => Promise<{ default: (o: object) => Promise<ExportModule> }>)(glue).then((m) => m.default({ printErr: () => {} })));

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const progress = (pct: number) => post({ type: 'progress', pct: Math.max(0, Math.min(100, Math.round(pct))) });

async function encode(r: Rendered, job: ExportJob, from: number, to: number): Promise<Uint8Array> {
  if (job.format === 'wav') { const w = wavPcm16(r); progress(to); return w; }
  return encodeM4a(r.samples, r.sr, r.ch, (k) => progress(from + (to - from) * k));
}

function send(name: string, data: Uint8Array) { post({ type: 'file', name, data }, [data.buffer]); }

async function run(M: ExportModule, job: ExportJob): Promise<number> {
  const ext = `.${job.format}`;
  if (job.kind === 'mix') {
    const r = mixdown(M, job.stems, job.metro, (k) => progress(70 * k));
    send(`${job.prefix}_mix_${job.stamp}${ext}`, await encode(r, job, 70, 100));
    return 1;
  }
  if (job.kind === 'stem') {
    const s = job.stem;
    const r = renderStem(M, s, job.metro);
    progress(50);
    send(`${job.prefix}_${s.stem}_${job.stamp}${ext}`, await encode(r, job, 70, 100));
    return 1;
  }
  let n = 0;
  for (const [i, s] of job.stems.entries()) {
    const from = i * 100 / job.stems.length, to = (i + 1) * 100 / job.stems.length;
    const name = `${job.prefix}_${s.stem}_${job.stamp}${ext}`;
    // Copia 1:1 solo si origen y destino son WAV y no hay FX
    if (job.format === 'wav' && /\.wav$/i.test(s.name) && !fxIsActive(s.fx)) { send(name, s.bytes); progress(to); }
    else send(name, await encode(renderStem(M, s, null), job, from, to));
    n++;
  }
  return n;
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  try {
    const M = await load(e.data.glue);
    post({ type: 'done', count: await run(M, e.data.job) });
  } catch (err) { post({ type: 'error', message: err instanceof Error ? err.message : String(err) }); }
};
