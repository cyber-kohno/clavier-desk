import type { PlaybackSequence, SamplePreparation, SamplePreparationProgress } from '../../service/playback/playback-instrument.ts';
import { DEFAULT_PLAYBACK_VELOCITY, playbackVelocity } from './playback-midi.ts';

// Zones in the local Piano in 162 bank, from Pianissimo to Forte.
const LAYER_MAX_VELOCITIES = [54, 68, 84, 103, 127];
const BATCH_SIZE = 4;
type Sample = { id: number; pitch: number; velocity: number };

function samplesFor(sequence: PlaybackSequence, defaultVelocity: number): Sample[] {
  const samples = new Map<number, Sample>();
  for (const event of sequence.events) {
    for (const [index, pitch] of event.pitches.entries()) {
      const velocity = playbackVelocity(event, index, defaultVelocity);
      if (velocity === 0 || pitch < 21 || pitch > 108) continue;
      const layer = LAYER_MAX_VELOCITIES.findIndex(max => velocity <= max);
      if (layer < 0) continue;
      const id = pitch * LAYER_MAX_VELOCITIES.length + layer;
      samples.set(id, { id, pitch, velocity });
    }
  }
  return [...samples.values()];
}

export function createPianoSamplePreparation(resume: () => Promise<void>, load: (sequence: PlaybackSequence) => Promise<void>) {
  const loaded = new Set<number>();
  let queue = Promise.resolve();
  function markLoaded(sequence: PlaybackSequence, velocity = DEFAULT_PLAYBACK_VELOCITY) {
    for (const sample of samplesFor(sequence, velocity)) loaded.add(sample.id);
  }

  function prepareSequence(sequence: PlaybackSequence, progress: (value: SamplePreparationProgress) => void,
    signal: AbortSignal): SamplePreparation | undefined {
    const missing = samplesFor(sequence, DEFAULT_PLAYBACK_VELOCITY).filter(sample => !loaded.has(sample.id));
    const total = missing.length;
    if (total === 0) return;
    signal.throwIfAborted();
    // Resume from the initiating user gesture, before an asynchronous readiness notification.
    const done = resume().then(() => {
      const run = queue.then(async () => {
        for (let start = 0; start < total; start += BATCH_SIZE) {
          signal.throwIfAborted();
          const batch = missing.slice(start, start + BATCH_SIZE);
          const needed = batch.filter(sample => !loaded.has(sample.id));
          if (needed.length) {
            await load({ durationSeconds: 0.5, pedalInitiallyDown: false, pedalEvents: [],
              events: needed.map(({ id, pitch, velocity }) => ({
                sourceNoteId: String(id), pitches: [pitch], velocity, startSeconds: 0, durationSeconds: 0.5,
              })),
            });
            for (const sample of needed) loaded.add(sample.id);
          }
          signal.throwIfAborted();
          progress({ completed: start + batch.length, total });
        }
      });
      queue = run.catch(() => {});
      return run;
    });
    return { total, done };
  }
  return { prepareSequence, markLoaded };
}
