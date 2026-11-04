// Mide la potencia por beat de la bateria fuera del hilo de la UI, con el decodificador de fision_export.
import { decode, type ExportModule } from '../export/mixdown.ts';
import { addBeatPower } from './beatPulseMap.ts';

export interface PulseJob { glue: string; beats: number[]; files: { name: string; bytes: Uint8Array }[] }

self.onmessage = async (e: MessageEvent<PulseJob>) => {
  const post = (power: Float64Array | null) => (self as unknown as Worker).postMessage({ power }, power ? [power.buffer] : []);
  try {
    const { glue, beats, files } = e.data;
    // import() sin que Vite lo reescriba (el glue vive en public/)
    const { default: create } = await (new Function('u', 'return import(u)') as (u: string) => Promise<{ default: (o: object) => Promise<ExportModule> }>)(glue);
    const M = await create({ printErr: () => {} });
    const power = new Float64Array(beats.length);
    for (const f of files) addBeatPower(decode(M, f.name, f.bytes), beats, power);
    post(power);
  } catch {
    post(null); // no se puede analizar: el pulso sigue siempre encendido
  }
};
