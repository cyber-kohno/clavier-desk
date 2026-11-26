import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const worklet = readFileSync(new URL('../src/infra/audio/piano-peak-limiter.js', import.meta.url), 'utf8');

function render(left, right, sampleRate, blockSize) {
  let Processor;
  runInNewContext(worklet, {
    sampleRate,
    AudioWorkletProcessor: class {},
    registerProcessor(name, implementation) {
      assert.equal(name, 'clavierdesk-piano-peak-limiter');
      Processor = implementation;
    },
  });
  const limiter = new Processor();
  const delay = Math.ceil(sampleRate * 0.005);
  const outputLeft = new Float32Array(left.length + delay);
  const outputRight = new Float32Array(outputLeft.length);
  for (let start = 0; start < outputLeft.length; start += blockSize) {
    const end = start + blockSize;
    assert.equal(limiter.process([[left.subarray(start, end), right.subarray(start, end)]], [
      [outputLeft.subarray(start, end), outputRight.subarray(start, end)],
    ]), true);
  }
  return { delay, outputLeft, outputRight };
}

test('quiet stereo audio retains its samples after the lookahead delay', () => {
  const left = Float32Array.from([0.25, 0.125, -0.5, 0.75]);
  const right = Float32Array.from([0.5, -0.25, 0.125, -0.125]);
  const { delay, outputLeft, outputRight } = render(left, right, 44100, 128);
  assert.ok(outputLeft.subarray(0, delay).every(value => value === 0));
  assert.deepEqual(outputLeft.subarray(delay), left);
  assert.deepEqual(outputRight.subarray(delay), right);
});

test('stereo peaks stay under the ceiling through transients, sustained peaks, and release', () => {
  const left = new Float32Array(24000).fill(0.25);
  left[127] = 3;
  left.fill(-2, 300, 1400);
  const right = Float32Array.from(left, value => value / 2);
  const ceiling = 10 ** (-1 / 20);
  const { delay, outputLeft, outputRight } = render(left, right, 48000, 128);
  for (let i = 0; i < outputLeft.length; i++) {
    assert.ok(Math.abs(outputLeft[i]) <= ceiling + 1e-7);
    assert.equal(outputRight[i], outputLeft[i] / 2);
  }
  assert.ok(outputLeft[delay + 126] < left[126], 'attack starts before the peak');
  assert.ok(outputLeft[delay + 1400] < left[1400], 'release is gradual');
  assert.ok(outputLeft.at(-1) > 0.249, 'gain recovers on quiet audio');
});
