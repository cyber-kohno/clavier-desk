import assert from 'node:assert/strict';
import { test } from 'node:test';
import Calculation from '../src/service/fingering/fingering-calculation.ts';

function worker(t) {
  const original = globalThis.Worker;
  let instance;
  globalThis.Worker = class {
    constructor() { instance = this; this.terminated = false; }
    postMessage(payload) { this.payload = payload; }
    terminate() { this.terminated = true; }
    send(data) { this.onmessage({ data }); }
  };
  t.after(() => { if (original === undefined) delete globalThis.Worker; else globalThis.Worker = original; });
  return () => instance;
}

test('cancelling terminates calculation and ignores late progress or completion', t => {
  const getWorker = worker(t), progress = [], completed = [];
  const project = { outline: [] }, selection = { staff: 'upperStaff', noteIds: ['a'] };
  const calculation = Calculation.start(project, selection, value => progress.push(value), value => completed.push(value));
  const running = getWorker();
  assert.deepEqual(running.payload, { project, selection });
  calculation.cancel();
  running.send({ type: 'progress', progress: { phase: 'search', completed: 1, total: 2 } });
  running.send({ type: 'result', result: { candidates: [], issues: [] } });
  assert.equal(running.terminated, true); assert.deepEqual(progress, []); assert.deepEqual(completed, []);
});

test('completion releases the worker once, and startup errors become a recoverable result', t => {
  const getWorker = worker(t), completed = [];
  Calculation.start({}, {}, () => {}, value => completed.push(value));
  const running = getWorker(), result = { candidates: [{ assignments: [], warnings: [], cost: 0 }], issues: [] };
  running.send({ type: 'result', result }); running.send({ type: 'result', result });
  assert.equal(running.terminated, true); assert.deepEqual(completed, [result]);
  Calculation.start({}, {}, () => {}, value => completed.push(value));
  let prevented = false;
  getWorker().onerror({ message: 'Worker unavailable', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(getWorker().terminated, true);
  assert.match(completed[1].issues[0].message, /Worker unavailable/);
});
