import assert from 'node:assert/strict';
import { test } from 'node:test';
import Authoring from '../src/action/editor/score-authoring.ts';
import EditTransaction from '../src/action/editor/edit-transaction.ts';
import ScoreEditing from '../src/action/editor/score-editing.ts';
import NoteEditor from '../src/action/editor/note-editor.ts';
import ScorePlaybackPlan from '../src/domain/performance/score-playback-plan.ts';
import ScoreDynamics from '../src/domain/score/score-dynamics.ts';
import ScoreHairpins from '../src/domain/score/score-hairpins.ts';
import ScoreProjectValidator from '../src/domain/score/score-project-validator.ts';
import Factory from '../src/domain/score/score-project.ts';
import ScoreTimeline from '../src/domain/score/score-timeline.ts';
import Preview from '../src/infra/musicxml/preview-musicxml.ts';
import { createTimelineCursor, moveFocusedTimelineNote } from '../src/state/timeline-cursor.ts';

function fixture() {
  const quarters = (...pitches) => pitches.map(pitch => ({ value: '4', pitches: [pitch] }));
  return Authoring.apply(Factory.create(), Authoring.createState(), [{ type: 'create_score',
    settings: { meter: [4, 4], keyFifths: 0, tempo: 120 }, measures: [
      { upper: [quarters('C4', 'D4', 'E4', 'F4'), quarters('G4', 'A4', 'B4', 'C5')],
        lower: [quarters('C3', 'D3', 'E3', 'F3')] }, {}, {}, {}, {},
    ] }]).project;
}

test('notation-only hairpins preserve current dynamics and configured velocities affect all simultaneous attacks', () => {
  const project = ScoreHairpins.add(fixture(), 2, 10);
  const [{ id }] = project.hairpins;
  const positionSamples = [0, 2, 4, 6, 8, 10, 12];
  const sample = score => positionSamples.map(ScoreDynamics.createVelocityLookup(score));
  assert.deepEqual(sample(project), [88, 88, 88, 88, 88, 88, 88]);

  const configured = ScoreHairpins.configure(project, id, 'decrescendo', 100);
  assert.deepEqual(sample(configured), [88, 88, 91, 94, 97, 100, 100]);
  const events = new Map(ScorePlaybackPlan.create(configured, 0).events.map(event => [event.pitches[0], event.velocity]));
  assert.deepEqual([events.get(62), events.get(69), events.get(50)], [91, 91, 91]);
  assert.deepEqual([events.get(65), events.get(72), events.get(53)], [100, 100, 100]);
  assert.deepEqual(sample(ScoreHairpins.remove(configured, 6)), sample(project));
});

test('endpoint marks supply live velocities without storing either value on the hairpin', () => {
  const score = fixture();
  const [first, , end] = ScoreTimeline.notes(score.outline, 'upperStaff', 0);
  let marked = ScoreDynamics.set(score, first.note.id, 'p', 68);
  marked = ScoreDynamics.set(marked, end.note.id, 'f', 103);
  const project = ScoreHairpins.add(marked, 0, 8);
  const sample = score => [0, 4, 8, 12].map(ScoreDynamics.createVelocityLookup(score));
  assert.equal(project.hairpins[0].endVelocity, undefined);
  assert.deepEqual(sample(project), [68, 86, 103, 103]);
  const editedStart = EditTransaction.commit(project, ScoreDynamics.set(project, first.note.id, 'p', 72));
  const editedEnd = EditTransaction.commit(editedStart, ScoreDynamics.set(editedStart, end.note.id, 'f', 110));
  assert.deepEqual(sample(editedEnd), [72, 91, 110, 110]);
  assert.equal(editedEnd.hairpins[0].endVelocity, undefined);
  assert.equal(ScoreDynamics.velocityAt(project, 4), 86);
});

test('new and resized hairpins allow optional endpoint marks and reject interior dynamics', () => {
  const score = fixture();
  const [first, middle, end] = ScoreTimeline.notes(score.outline, 'upperStaff', 0);
  const mark = (project, entry) => ScoreDynamics.set(project, entry.note.id, 'p', 68);
  const allowsNew = project => Boolean(ScoreDynamics.reconcileHairpins(project, ScoreHairpins.add(project, 0, 8)));
  assert.equal(allowsNew(score), true);
  assert.equal(allowsNew(mark(score, first)), true);
  assert.equal(allowsNew(mark(score, end)), true);
  assert.equal(allowsNew(mark(mark(score, first), end)), true);
  assert.equal(allowsNew(mark(mark(score, first), middle)), false);

  const anchored = ScoreHairpins.add(mark(score, end), 0, 8);
  assert.ok(ScoreDynamics.reconcileHairpins(anchored, ScoreHairpins.moveEndpoint(anchored, 'start', 4)));
  const shortened = ScoreDynamics.reconcileHairpins(anchored, ScoreHairpins.moveEndpoint(anchored, 'end', 6));
  assert.equal(shortened.hairpins[0].endVelocity, 68);
  const reattached = ScoreDynamics.reconcileHairpins(shortened, ScoreHairpins.moveEndpoint(shortened, 'end', 8));
  assert.equal(reattached.hairpins[0].endVelocity, undefined);
  assert.equal(ScoreDynamics.reconcileHairpins(anchored, ScoreHairpins.moveEndpoint(anchored, 'end', 12)), undefined);
  const markedStart = ScoreHairpins.add(mark(score, middle), 4, 8);
  assert.equal(ScoreDynamics.reconcileHairpins(markedStart, ScoreHairpins.moveEndpoint(markedStart, 'start', 0)), undefined);
});

test('editor commits reject marks in the interior and allow removal of the last endpoint mark', () => {
  const score = fixture();
  const [first, middle, end] = ScoreTimeline.notes(score.outline, 'upperStaff', 0);
  const marked = ScoreDynamics.set(score, end.note.id, 'f', 103);
  const project = ScoreHairpins.add(marked, 0, 8);
  const withInterior = ScoreDynamics.set(project, middle.note.id, 'mf', 88);
  const withoutEnd = ScoreDynamics.set(project, end.note.id, null);
  assert.equal(EditTransaction.commit(project, withInterior), project);
  const removed = EditTransaction.commit(project, withoutEnd);
  assert.deepEqual(ScoreDynamics.changes(removed), []);
  assert.equal(removed.hairpins[0].endVelocity, 103);

  const addStart = { type: 'set_dynamic_change', noteId: first.note.id, level: 'p', velocity: 68 };
  const removeEnd = { type: 'set_dynamic_change', noteId: end.note.id, level: null, velocity: 103 };
  const state = Authoring.createState();
  const addInterior = { type: 'set_dynamic_change', noteId: middle.note.id, level: 'mf', velocity: 88 };
  assert.throws(() => ScoreEditing.apply(project, state, [addInterior]), /cannot be inside a hairpin/);
  const removedByBatch = ScoreEditing.apply(project, state, [removeEnd]).project;
  assert.deepEqual(ScoreDynamics.changes(removedByBatch), []);
  assert.equal(removedByBatch.hairpins[0].endVelocity, 103);
  const moved = ScoreEditing.apply(project, state, [removeEnd, addStart]).project;
  assert.deepEqual(ScoreDynamics.changes(moved).map(mark => mark.position), [0]);
  const rested = ScoreEditing.apply(project, state, [{ type: 'set_rest', noteId: end.note.id }]).project;
  assert.equal(rested.hairpins[0].endVelocity, 103);
});

test('moving a note that carries an endpoint mark cannot place the mark inside a hairpin', () => {
  const score = Authoring.apply(Factory.create(), Authoring.createState(), [{ type: 'create_score',
    settings: { meter: [4, 4], keyFifths: 0, tempo: 120 },
    measures: [{ upper: [[{ value: '2', rest: true }, { value: '4', pitches: ['C4'] }, { value: '4', rest: true }]] }],
  }]).project;
  const [end] = ScoreTimeline.notes(score.outline, 'upperStaff', 0);
  const project = ScoreHairpins.add(ScoreDynamics.set(score, end.note.id, 'f', 103), 0, 8);
  const cursor = { ...createTimelineCursor(), focusedNoteId: end.note.id, positionSixteenths: 8 };
  const candidate = moveFocusedTimelineNote(project, cursor, -1);
  assert.ok(candidate);
  assert.ok(ScoreDynamics.changes(candidate.project)[0].position < 8);
  assert.equal(NoteEditor.move(project, cursor, -1), undefined);
  const moved = NoteEditor.move(project, cursor, 1).project;
  assert.ok(ScoreDynamics.changes(moved)[0].position > 8);
  assert.equal(moved.hairpins[0].endVelocity, 103);
});

test('adjacent hairpins share the endpoint velocity, and a mark discards the previous manual setting', () => {
  const project = ScoreHairpins.add(ScoreHairpins.add(fixture(), 0, 4), 4, 8);
  const [, shared] = ScoreTimeline.notes(project.outline, 'upperStaff', 0);
  const [first, second] = project.hairpins;
  const configured = ScoreHairpins.configure(ScoreHairpins.configure(project, first.id, 'crescendo', 100),
    second.id, 'decrescendo', 80);
  const sample = score => [0, 2, 4, 6, 8, 12].map(ScoreDynamics.createVelocityLookup(score));
  assert.deepEqual(sample(configured), [88, 94, 100, 90, 80, 80]);
  const withMark = ScoreDynamics.set(configured, shared.note.id, 'f', 106);
  assert.equal(ScoreDynamics.hasValidHairpins(withMark), false);
  const marked = EditTransaction.commit(configured, withMark);
  assert.equal(marked.hairpins[0].endVelocity, undefined);
  assert.deepEqual(sample(marked), [88, 97, 106, 93, 80, 80]);
  const removed = EditTransaction.commit(marked, ScoreDynamics.set(marked, shared.note.id, null));
  assert.equal(removed.hairpins[0].endVelocity, 106);
  assert.deepEqual(sample(removed), sample(marked));
});

test('hairpins persist across empty measures and preview boundaries, and reconcile deleted endpoints', () => {
  const project = ScoreHairpins.add(fixture(), 5, 66);
  const { id, start, end } = project.hairpins[0];
  assert.equal(ScoreHairpins.add(project, 6, 14), project);
  const adjacent = ScoreHairpins.add(project, 66, 80);
  assert.equal(ScoreHairpins.at(adjacent, 66).hairpin.id, adjacent.hairpins[1].id);
  assert.equal(ScoreHairpins.at(adjacent, 65).hairpin.id, id);
  const restored = JSON.parse(JSON.stringify(project));
  assert.ok(ScoreProjectValidator.isValid(restored));
  const oldFormat = { ...restored, hairpins: [{ ...restored.hairpins[0], velocities: { start: 70, end: 90 } }] };
  assert.equal(ScoreProjectValidator.isValid(oldFormat), false);
  const withEndVelocity = ScoreHairpins.configure(restored, id, 'crescendo', 110);
  const saved = JSON.parse(JSON.stringify(withEndVelocity));
  assert.ok(ScoreProjectValidator.isValid(saved));
  assert.equal(saved.hairpins[0].endVelocity, 110);
  const invalid = { ...restored, hairpins: [{ ...restored.hairpins[0], end: { ...end, measureId: 'missing-measure' } }] };
  assert.equal(ScoreProjectValidator.isValid(invalid), false);
  const clipped = Preview.create(restored.outline, 2, [], [], [], [], [], undefined, restored.hairpins).hairpins;
  assert.deepEqual(clipped, [{ start: { measureOffset: 0, position: 0, opening: 11 / 61 },
    end: { measureOffset: 2, position: 16, opening: 59 / 61 } }]);
  const deleted = { ...restored, outline: restored.outline.filter(block => block.id !== start.measureId) };
  assert.deepEqual(EditTransaction.commit(restored, deleted).hairpins, []);
});

test('a new hairpin can start at a free position or an unshared end, but not inside an existing range', () => {
  const project = ScoreHairpins.add(fixture(), 4, 12);
  assert.equal(ScoreHairpins.canStartAt(project, 3), true);
  assert.equal(ScoreHairpins.canStartAt(project, 4), false);
  assert.equal(ScoreHairpins.canStartAt(project, 8), false);
  assert.equal(ScoreHairpins.canStartAt(project, 12), true);

  const adjacent = ScoreHairpins.add(project, 12, 16);
  assert.equal(ScoreHairpins.canStartAt(adjacent, 12), false);
  assert.equal(ScoreHairpins.canStartAt(adjacent, 16), true);
  assert.equal(ScoreHairpins.canStartAt(adjacent, ScoreTimeline.index(project.outline).length), false);
});

test('moving hairpin endpoints uses the containing range or the neighbor in the requested direction', () => {
  const left = ScoreHairpins.add(fixture(), 4, 12);
  const both = ScoreHairpins.add(left, 20, 24);
  const [first, second] = both.hairpins;
  const project = ScoreHairpins.configure(both, second.id, 'decrescendo', 60);
  const positions = score => ScoreHairpins.ranges(score).map(({ start, end }) => [start, end]);

  const extendedStart = ScoreHairpins.moveEndpoint(project, 'start', 13);
  assert.deepEqual(positions(extendedStart), [[4, 12], [13, 24]]);
  assert.equal(extendedStart.hairpins[0], first);
  assert.deepEqual(extendedStart.hairpins[1], { ...project.hairpins[1], start: extendedStart.hairpins[1].start });
  assert.deepEqual(positions(ScoreHairpins.moveEndpoint(project, 'start', 22)), [[4, 12], [22, 24]]);
  assert.deepEqual(positions(ScoreHairpins.moveEndpoint(project, 'end', 19)), [[4, 19], [20, 24]]);
  assert.deepEqual(positions(ScoreHairpins.moveEndpoint(project, 'end', 22)), [[4, 12], [20, 22]]);

  const scoreEnd = ScoreTimeline.index(project.outline).length;
  const extendedEnd = ScoreHairpins.moveEndpoint(project, 'end', scoreEnd);
  assert.deepEqual(positions(extendedEnd), [[4, 12], [20, scoreEnd]]);
  assert.ok(ScoreProjectValidator.isValid(extendedEnd));
});

test('moving hairpin endpoints leaves boundaries and unavailable positions intact', () => {
  const left = ScoreHairpins.add(fixture(), 4, 12);
  const adjacent = ScoreHairpins.add(left, 12, 24);
  for (const endpoint of ['start', 'end']) {
    assert.equal(ScoreHairpins.moveEndpoint(adjacent, endpoint, 12), adjacent);
    assert.equal(ScoreHairpins.moveEndpoint(left, endpoint, 4), left);
    assert.equal(ScoreHairpins.moveEndpoint(left, endpoint, 12), left);
  }

  const scoreEnd = ScoreTimeline.index(left.outline).length;
  for (const position of [-1, 13]) assert.equal(ScoreHairpins.moveEndpoint(left, 'start', position), left);
  for (const position of [3, scoreEnd + 1]) assert.equal(ScoreHairpins.moveEndpoint(left, 'end', position), left);
});
