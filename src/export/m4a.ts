// M4A = AAC LC (codificador del navegador, WebCodecs) en MP4 (mp4-muxer, MIT). 192 kbit/s como
// AacEncoder.BITRATE_DEFAULT. Sin codificador AAC (p. ej. algunos Linux) no se ofrece M4A.
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

const CODEC = 'mp4a.40.2';
const BITRATE = 192000;
const STEP = 8192; // frames por AudioData

export async function canEncodeAac(sampleRate = 48000, channels = 2): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return false;
  try { return !!(await AudioEncoder.isConfigSupported({ codec: CODEC, sampleRate, numberOfChannels: channels, bitrate: BITRATE })).supported; }
  catch { return false; }
}

export async function encodeM4a(samples: Float32Array, sampleRate: number, channels: number, progress: (k: number) => void = () => {}): Promise<Uint8Array> {
  const muxer = new Muxer({ target: new ArrayBufferTarget(), audio: { codec: 'aac', numberOfChannels: channels, sampleRate }, fastStart: 'in-memory' });
  let failed: unknown = null;
  const enc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { failed = e; } });
  enc.configure({ codec: CODEC, sampleRate, numberOfChannels: channels, bitrate: BITRATE });
  const frames = samples.length / channels;
  for (let f = 0; f < frames; f += STEP) {
    const k = Math.min(STEP, frames - f);
    const data = samples.slice(f * channels, (f + k) * channels);
    for (let i = 0; i < data.length; i++) data[i] = Math.max(-1, Math.min(1, data[i]));
    const ad = new AudioData({ format: 'f32', sampleRate, numberOfFrames: k, numberOfChannels: channels, timestamp: Math.round(f * 1e6 / sampleRate), data });
    enc.encode(ad);
    ad.close();
    // No llenar la cola del codificador (memoria)
    while (enc.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 1));
    if (failed) throw failed;
    progress(f / frames);
  }
  await enc.flush();
  enc.close();
  if (failed) throw failed;
  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}
