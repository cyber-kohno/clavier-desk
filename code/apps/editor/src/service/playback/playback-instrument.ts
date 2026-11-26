import type { PlaybackPlan } from '../../domain/performance/score-playback-plan.ts';

export type PlaybackSequence = Pick<PlaybackPlan, 'events' | 'pedalEvents' | 'pedalInitiallyDown' | 'durationSeconds'>;
export type SequenceRun = { readonly ready?: boolean; readonly currentTime: number };
export type SequenceCallbacks = { ended(): void; failed(error: unknown): void };
export type SequencePlaybackOptions = { reverbDepth?: number };
export type SamplePreparationProgress = { completed: number; total: number };
export type SamplePreparation = { total: number; done: Promise<void> };

export type PlaybackInstrumentPort = {
  prepareSequence?(sequence: PlaybackSequence, progress: (value: SamplePreparationProgress) => void,
    signal: AbortSignal): SamplePreparation | undefined;
  startSequence(sequence: PlaybackSequence, callbacks: SequenceCallbacks, options?: SequencePlaybackOptions): SequenceRun;
  play(pitches: readonly number[], velocity: number, durationMs: number): void;
  setSustainPedal(down: boolean): void;
  stop(): void;
  dispose(): void;
};
