import type { PlaybackInstrumentPort, PlaybackSequence, SequenceRun } from './playback-instrument.ts';

const ANIMATION_REVERB_DEPTH = 48;

/** Slice an immutable generated sequence for seek/resume; speed scales both clocks. */
export function animationSequenceAt(sequence: PlaybackSequence, position: number, speed: number): PlaybackSequence {
  if (!(speed > 0) || !Number.isFinite(speed)) throw new Error('Playback speed must be positive.');
  const at = Math.max(0, Math.min(sequence.durationSeconds, position));
  const preceding = sequence.pedalEvents.filter(event => event.atSeconds < at).at(-1);
  return {
    durationSeconds: (sequence.durationSeconds - at) / speed,
    pedalInitiallyDown: preceding ? preceding.action !== 'stop' : sequence.pedalInitiallyDown,
    pedalEvents: sequence.pedalEvents.filter(event => event.atSeconds >= at)
      .map(event => ({ ...event, atSeconds: (event.atSeconds - at) / speed })),
    events: sequence.events.flatMap(event => event.pitches.flatMap((pitch, index) => {
      const end = event.startSeconds + (event.pitchDurationsSeconds?.[index] ?? event.durationSeconds);
      if (end <= at) return [];
      const onset = Math.max(at, event.startSeconds);
      return [{ ...event, pitches: [pitch], performance: event.performance?.[index] ? [event.performance[index]] : undefined,
        pitchDurationsSeconds: undefined, startSeconds: (onset - at) / speed, durationSeconds: (end - onset) / speed }];
    })),
  };
}

export function createAnimationTransport(instrument: PlaybackInstrumentPort | null, failed: (error: unknown) => void,
  now: () => number = () => performance.now() / 1000) {
  let sequence: PlaybackSequence | undefined, run: SequenceRun | undefined;
  let playing = false, position = 0, speed = 1, start = 0, wallStart = 0, generation = 0;
  const current = () => playing ? Math.min(sequence!.durationSeconds,
    start + (run ? (run.ready === false ? 0 : run.currentTime) : now() - wallStart) * speed) : position;
  function pause() {
    position = current(); playing = false; generation++; run = undefined; instrument?.stop();
  }
  function play() {
    if (!sequence || playing) return;
    if (position >= sequence.durationSeconds) position = 0;
    start = position; wallStart = now(); playing = true;
    const token = ++generation;
    const failure = (error: unknown) => { if (token === generation) { pause(); failed(error); } };
    try { run = instrument?.startSequence(animationSequenceAt(sequence, position, speed), {
      ended() { if (token === generation) { position = sequence!.durationSeconds; playing = false; run = undefined; } }, failed: failure,
    }, { reverbDepth: ANIMATION_REVERB_DEPTH }); } catch (error) { failure(error); }
  }
  return {
    get playing() { return playing; },
    get position() {
      const value = current();
      if (playing && value >= sequence!.durationSeconds) pause();
      return value;
    },
    setSequence(value: PlaybackSequence) { pause(); sequence = value; position = 0; },
    play, pause,
    seek(value: number) { pause(); position = Math.max(0, Math.min(sequence?.durationSeconds ?? 0, value)); },
    setSpeed(value: number) { const resume = playing; pause(); speed = value; if (resume) play(); },
    dispose: pause,
  };
}
