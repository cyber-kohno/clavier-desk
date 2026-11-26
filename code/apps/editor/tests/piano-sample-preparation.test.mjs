import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPianoSamplePreparation } from '../src/infra/audio/piano-sample-preparation.ts';

function sequence(...notes) {
  return {
    durationSeconds: 1, pedalInitiallyDown: false, pedalEvents: [],
    events: notes.map(({ pitches, velocity, pitchVelocities }, index) => ({
      sourceNoteId: String(index), startSeconds: 0, durationSeconds: 1, pitches, velocity, pitchVelocities,
    })),
  };
}

test('preparation counts missing recordings by key and velocity layer shared with audition', async () => {
  const batches = [], updates = [];
  const preparation = createPianoSamplePreparation(async () => {}, async batch => batches.push(batch.events));
  preparation.markLoaded(sequence({ pitches: [60] }), 88);
  const score = sequence({ pitches: [60, 62], pitchVelocities: [100, 103] }, { pitches: [60], velocity: 104 },
    { pitches: [62], velocity: 85 }, { pitches: [63, 64, 65, 66] }, { pitches: [20, 109] }, { pitches: [67], velocity: 0 });
  const signal = new AbortController().signal;
  const load = preparation.prepareSequence(score, value => updates.push(value), signal);
  assert.equal(load.total, 6);
  await load.done;
  assert.deepEqual(updates, [{ completed: 4, total: 6 }, { completed: 6, total: 6 }]);
  assert.deepEqual(batches.flat().map(event => [event.pitches[0], event.velocity]),
    [[62, 85], [60, 104], [63, 88], [64, 88], [65, 88], [66, 88]]);
  assert.equal(preparation.prepareSequence(score, assert.fail, signal), undefined);
});

test('cancelling stops further batches and reuses the batch already acknowledged', async () => {
  const controller = new AbortController();
  let complete;
  let loading = 0;
  const preparation = createPianoSamplePreparation(async () => {}, () => {
    loading++;
    return new Promise(resolve => { complete = resolve; });
  });
  const score = sequence({ pitches: [60, 61, 62, 63, 64] });
  const first = preparation.prepareSequence(score, assert.fail, controller.signal);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(loading, 1);
  controller.abort();
  complete();
  await assert.rejects(first.done, { name: 'AbortError' });
  const next = preparation.prepareSequence(score, () => {}, new AbortController().signal);
  assert.equal(next.total, 1);
  await Promise.resolve();
  await Promise.resolve();
  complete();
  await next.done;
});
