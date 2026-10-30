// Trabajo de export que va al Worker (ExportManager.exportMixdown / exportSeparate / exportSingleStem).
import type { FxParams, Metronome, MixStem } from './mixdown.ts';

export type ExportFormat = 'wav' | 'm4a';
export interface StemSrc { stem: string; name: string; bytes: Uint8Array; fx: FxParams | null }

export type ExportJob = { format: ExportFormat; prefix: string; stamp: string } & (
  | { kind: 'mix'; stems: MixStem[]; metro: Metronome | null }
  | { kind: 'separate'; stems: StemSrc[] }
  | { kind: 'stem'; stem: StemSrc; metro: Metronome | null }
);

export type ToWorker = { type: 'run'; job: ExportJob; glue: string };
export type FromWorker =
  | { type: 'progress'; pct: number }
  | { type: 'file'; name: string; data: Uint8Array }
  | { type: 'done'; count: number }
  | { type: 'error'; message: string };
