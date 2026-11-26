import type { PlaybackSequence, SequenceCallbacks, SequencePlaybackOptions, SequenceRun } from '../../service/playback/playback-instrument.ts';
import { createPlaybackMidi, DEFAULT_PLAYBACK_VELOCITY } from './playback-midi.ts';

export type SequenceEngine = {
  resume(): Promise<void>;
  load(binary: ArrayBuffer): void;
  play(): void;
  pause(): void;
  readonly currentTime: number;
  silence(): void;
};

/** The engine owns the audio clock. Main-thread callbacks only update UI state. */
export function createWorkletSequencePlayer(engine: SequenceEngine) {
  let generation = 0;
  let active: { generation: number; callbacks: SequenceCallbacks } | undefined;
  const pending: { generation: number; callbacks: SequenceCallbacks; ready: boolean; onLoaded?: () => void }[] = [];
  function stop() {
    generation++;
    active = undefined;
    engine.pause();
    engine.silence();
  }
  function startSequence(sequence: PlaybackSequence, callbacks: SequenceCallbacks, velocity = DEFAULT_PLAYBACK_VELOCITY,
    options?: SequencePlaybackOptions, onLoaded?: () => void): SequenceRun {
    const binary = createPlaybackMidi(sequence, velocity, options);
    stop();
    const run = { generation, callbacks, ready: false, onLoaded };
    void engine.resume().then(() => {
      if (run.generation !== generation) return;
      pending.push(run);
      try { engine.load(binary); }
      catch (error) { pending.pop(); throw error; }
    }).catch(error => {
      if (run.generation !== generation) return;
      stop();
      callbacks.failed(error);
    });
    return { get ready() { return run.ready && run.generation === generation; }, get currentTime() {
      return run.ready && run.generation === generation
        ? Math.max(0, Math.min(sequence.durationSeconds, engine.currentTime)) : 0;
    } };
  }
  return {
    startSequence, stop,
    loaded() {
      const run = pending.shift();
      run?.onLoaded?.();
      if (!run || run.generation !== generation) return;
      active = run;
      run.ready = true;
      engine.play();
    },
    ended() {
      const run = active;
      if (!run || run.generation !== generation) return;
      active = undefined;
      run.callbacks.ended();
    },
    failed(error: unknown) {
      const run = pending.shift();
      if (!run || run.generation !== generation) return;
      stop();
      run.callbacks.failed(error);
    },
  };
}
