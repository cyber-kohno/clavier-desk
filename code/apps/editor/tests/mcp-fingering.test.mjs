import { test } from 'node:test';
import assert from 'node:assert/strict';
import Jobs from '../src/service/mcp/mcp-fingering-jobs.ts';
import Factory from '../src/domain/score/score-project.ts';
import Measure from '../src/domain/score/score-measure.ts';
import Passage from '../src/domain/performance/fingering-passage.ts';
import Automatic from '../src/domain/performance/automatic-fingering.ts';

function fixture() {
  const project = Factory.create(), data = Measure.create({ cnt: 4, unit: 4 });
  data.upperStaff.voices[0].elements = ['a', 'b'].map((id, i) => ({ id, kind: 'note', value: { type: 'half', dots: 0 }, pitches: [{ midi: 60 + i * 2, ...(i ? {} : { fingering: 1 }) }] }));
  project.outline.push({ id: 'm', type: 'measure', data });
  const checkout = { project, revision: 'r1' };
  let complete, cancelled = false;
  const jobs = Jobs.create((project, selection, progress, callback) => {
    complete = () => callback(Automatic.calculate(Passage.prepare(project, selection).passage));
    return { cancel() { cancelled = true; } };
  });
  const args = { requestId: 'request1', expectedRevision: 'r1', staff: 'upperStaff', noteIds: ['a', 'b'] };
  const call = (method, params) => jobs.handle(method, params, checkout);
  return { checkout, jobs, call, args, finish: () => complete(), cancelled: () => cancelled };
}
test('MCP calculation uses the existing engine, preserves pins, stages only on apply and retries safely', () => {
  const f = fixture(), baseline = f.checkout.project;
  const job = f.call('requestAutoFingering', f.args);
  assert.deepEqual(f.call('requestAutoFingering', f.args), job);
  assert.equal(f.call('getAutoFingeringResult', job).status, 'running');
  assert.equal(f.checkout.project, baseline);
  f.finish();
  const result = f.call('getAutoFingeringResult', job);
  assert.equal(result.status, 'ready');
  assert.equal(baseline.outline.at(-1).data.upperStaff.voices[0].elements[1].pitches[0].fingering, undefined);
  const applied = f.call('applyAutoFingering', { ...job, expectedRevision: 'r1' });
  assert.equal(applied.changed, true);
  const notes = f.checkout.project.outline.at(-1).data.upperStaff.voices[0].elements;
  assert.equal(notes[0].pitches[0].fingering, 1);
  assert.ok(notes[1].pitches[0].fingering);
  assert.deepEqual(f.call('applyAutoFingering', { ...job, expectedRevision: 'r1' }), applied);
});
test('MCP rejects stale candidates, conflicting retries and clears running workers', () => {
  const f = fixture(), job = f.call('requestAutoFingering', f.args);
  assert.throws(() => f.call('requestAutoFingering', { ...f.args, noteIds: ['a'] }), /already used/);
  f.finish(); f.checkout.revision = 'r2';
  assert.throws(() => f.call('applyAutoFingering', { ...job, expectedRevision: 'r2' }), /changed since/);
  f.jobs.clear();
  assert.throws(() => f.call('getAutoFingeringResult', job), /No such/);
  const g = fixture(); g.call('requestAutoFingering', g.args); g.jobs.clear(); assert.equal(g.cancelled(), true);
});
test('MCP exposes and applies grace assignments under their principal note', () => {
  const f = fixture();
  f.checkout.project.outline.at(-1).data.upperStaff.voices[0].elements[0].beforeGraceNotes = [
    { id: 'g', value: { type: '16th', dots: 0 }, pitches: [{ midi: 59 }] },
  ];
  const job = f.call('requestAutoFingering', f.args); f.finish();
  const result = f.call('getAutoFingeringResult', job);
  assert.equal(result.status, 'ready');
  const grace = result.result.candidates[0].assignments.find(a => a.graceNoteId === 'g');
  assert.equal(grace.noteId, 'a');
  f.call('applyAutoFingering', { ...job, expectedRevision: 'r1' });
  assert.equal(f.checkout.project.outline.at(-1).data.upperStaff.voices[0].elements[0].beforeGraceNotes[0].pitches[0].fingering, grace.finger);
});
test('MCP stages a trill sequence using individual attack indices', () => {
  const f = fixture();
  f.checkout.project.trills = [{ id: 'trill', kind: 'trill', startNoteId: 'b', endNoteId: 'b',
    settings: { auxiliary: 'diatonic', start: 'auxiliary', attackCount: 4 } }];
  const job = f.call('requestAutoFingering', f.args);
  f.finish();
  const result = f.call('getAutoFingeringResult', job);
  assert.equal(result.status, 'ready');
  const assignments = result.result.candidates[0].assignments;
  assert.deepEqual(assignments.map(a => [a.noteId, a.trillAttackIndex]), [['b', 0], ['b', 1], ['b', 2], ['b', 3]]);
  assert.equal(f.checkout.project.trills[0].settings.fingerings, undefined);
  f.call('applyAutoFingering', { ...job, expectedRevision: 'r1' });
  assert.deepEqual(f.checkout.project.trills[0].settings.fingerings, assignments.map(a => a.finger));
});
test('invalid arpeggio settings produce a failed result without editing the checkout', () => {
  const f = fixture(), baseline = f.checkout.project;
  baseline.outline.at(-1).data.upperStaff.voices[0].elements[0].arpeggio = { type: 'normal', spreadRatio: 1, timing: 0 };
  const job = f.call('requestAutoFingering', f.args), result = f.call('getAutoFingeringResult', job);
  assert.equal(result.status, 'failed'); assert.match(result.result.issues[0].message, /invalid arpeggio settings/);
  assert.throws(() => f.call('applyAutoFingering', { ...job, expectedRevision: 'r1' }), /Calculation failed/);
  assert.equal(f.checkout.project, baseline);
});
