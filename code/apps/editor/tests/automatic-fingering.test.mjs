import assert from 'node:assert/strict';
import { test } from 'node:test';
import Project from '../src/domain/score/score-project.ts';
import Measure from '../src/domain/score/score-measure.ts';
import Timeline from '../src/domain/score/score-timeline.ts';
import Selection from '../src/domain/score/fingering-selection.ts';
import Passage from '../src/domain/performance/fingering-passage.ts';
import Engine from '../src/domain/performance/automatic-fingering.ts';
import Editor from '../src/action/editor/fingering-editor.ts';
import History from '../src/service/history/editor-history.ts';
import { inspectAnimation } from '../src/domain/performance/animation-performance.ts';
import { generateAnimation } from '../src/service/playback/animation-generation.ts';
import { createNoteMenuItems, controlNoteMenu } from '../src/state/note-menu.ts';

const note = (id, pitches, extra = {}) => ({ id, kind: 'note', value: { type: 'eighth', dots: 0 },
  pitches: pitches.map(pitch => typeof pitch === 'number' ? { midi: pitch } : pitch).sort((a, b) => b.midi - a.midi), ...extra });

test('grace attacks and principal notes share playback timing, preserve anchors and apply atomically', () => {
  for (const slash of [false, true]) {
    const { project, selection } = setup([note('a', [64], { value: { type: 'half', dots: 0 }, beforeGraceNotes: [
      { id: 'g1', pitches: [{ midi: 60, fingering: 1 }], value: { type: '16th', dots: 0 }, slash },
      { id: 'g2', pitches: [{ midi: 62 }], value: { type: '16th', dots: 0 }, slash },
    ] }), note('b', [65], { value: { type: 'half', dots: 0 } })]);
    const prepared = Passage.prepare(project, selection);
    assert.deepEqual(prepared.issues, []);
    assert.deepEqual(prepared.passage.steps.map(s => s.attacks[0].midi), [60, 62, 64, 65]);
    assert.equal(prepared.passage.steps[0].time, 0.6);
    assert.equal(prepared.passage.missing, 3);
    const draft = run(project, selection);
    const grace = draft.assignments.find(a => a.graceNoteId === 'g2');
    assert.equal(grace.noteId, 'a');
    assert.equal(Editor.apply(project, selection, draft.assignments.filter(a => !a.graceNoteId)), project);
    assert.equal(Editor.apply(project, selection, [...draft.assignments, grace]), project);
    const applied = Editor.apply(project, selection, draft.assignments);
    assert.equal(Selection.inspect(applied, selection).missing, 0);
    const graces = Timeline.note(applied.outline, 'a').note.beforeGraceNotes;
    assert.equal(graces[0].pitches[0].fingering, 1);
    assert.ok(graces[1].pitches[0].fingering);
    assert.equal(Timeline.note(project.outline, 'a').note.beforeGraceNotes[1].pitches[0].fingering, undefined);
    const inspected = inspectAnimation(applied);
    assert.deepEqual(inspected.issues, []); generateAnimation(inspected.performance);
    const cleared = Editor.clear(applied, selection);
    assert.equal(Timeline.note(cleared.outline, 'a').note.beforeGraceNotes[0].pitches[0].fingering, undefined);
  }
});
function setup(elements, staff = 'upperStaff') {
  const project = Project.create(), data = Measure.create({ unit: 4, cnt: 4 });
  data[staff].voices[0].elements = elements;
  project.outline.push({ id: 'm', type: 'measure', data });
  const selection = { staff, noteIds: elements.filter(element => element.kind === 'note').map(element => element.id) };
  return { project, selection };
}
function run(project, selection) {
  const prepared = Passage.prepare(project, selection);
  assert.deepEqual(prepared.issues, []);
  const result = Engine.calculate(prepared.passage);
  assert.deepEqual(result.issues, []);
  assert.equal(result.candidates.length, 1);
  return result.candidates[0];
}
function fingers(project, selection) {
  return selection.noteIds.map(id => Timeline.note(project.outline, id, selection.staff).note.pitches.map(pitch => pitch.fingering));
}

test('an octave with an inner note can be assigned and pressed together in either hand', () => {
  for (const staff of ['lowerStaff', 'upperStaff']) {
    const { project, selection } = setup([note('octave', [53, 60, 65], { value: { type: 'whole', dots: 0 } })], staff);
    const draft = run(project, selection);
    const inspected = inspectAnimation(Editor.apply(project, selection, draft.assignments));
    assert.deepEqual(inspected.issues, []);
    const { notes } = generateAnimation(inspected.performance);
    assert.equal(notes.length, 3);
    assert.ok(notes.every(event => event.time === notes[0].time));
    assert.deepEqual(notes.map(event => event.midiNote).sort((a, b) => a - b), [53, 60, 65]);
  }
});

test('an unannotated scale is assigned as a whole, crosses the thumb and animates', () => {
  const { project, selection } = setup([60, 62, 64, 65, 67, 69, 71, 72].map((midi, i) => note(`n${i}`, [midi])));
  const before = structuredClone(project), draft = run(project, selection);
  const applied = Editor.apply(project, selection, draft.assignments);
  assert.equal(draft.assignments.length, 8);
  const sequence = fingers(applied, selection).flat();
  assert.ok(sequence.slice(1).some((finger, i) => finger === 1 && sequence[i] > 1));
  const inspected = inspectAnimation(applied);
  assert.equal(inspected.issues.length, 0);
  generateAnimation(inspected.performance);
  assert.deepEqual(project, before);
  assert.deepEqual(run(project, selection), draft);
});

test('middle and end anchors are fixed, and only missing pitches are filled', () => {
  const { project, selection } = setup([note('a', [60]), note('b', [{ midi: 62, fingering: 2 }]), note('c', [64]), note('d', [{ midi: 65, fingering: 4 }])]);
  const draft = run(project, selection), applied = Editor.apply(project, selection, draft.assignments);
  assert.equal(draft.assignments.length, 2);
  assert.equal(fingers(applied, selection)[1][0], 2);
  assert.equal(fingers(applied, selection)[3][0], 4);
  assert.equal(Selection.inspect(applied, selection).missing, 0);
  assert.strictEqual(Editor.apply(applied, selection, draft.assignments), applied);
});

test('right and left hand chord orders are mirrored and held chord contacts animate', () => {
  for (const staff of ['upperStaff', 'lowerStaff']) {
    const { project, selection } = setup([note('chord', [60, 64, 67])], staff);
    const applied = Editor.apply(project, selection, run(project, selection).assignments);
    const [assigned] = fingers(applied, selection);
    assert.equal(new Set(assigned).size, 3);
    assert.ok(staff === 'upperStaff' ? assigned[0] > assigned[1] && assigned[1] > assigned[2] : assigned[0] < assigned[1] && assigned[1] < assigned[2]);
    const inspection = inspectAnimation(applied);
    assert.deepEqual(inspection.issues, []); generateAnimation(inspection.performance);
  }
});

test('opposite hand is excluded while overlapping same-hand voices are included', () => {
  const { project, selection } = setup([note('a', [60]), note('b', [62])]);
  const prepared = Passage.prepare(project, selection);
  const changed = structuredClone(project);
  changed.outline[2].data.lowerStaff.voices[0].elements = [note('left', [{ midi: 60, fingering: 1 }])];
  assert.deepEqual(Passage.prepare(changed, selection), prepared);
  changed.outline[2].data.upperStaff.voices.push({ id: 'v2', elements: [note('other', [{ midi: 67 }], { value: { type: 'whole', dots: 0 } })] });
  const inspection = Selection.inspect(changed, selection);
  assert.equal(inspection.voiceCount, 2);
  assert.equal(inspection.addedNotes, 1);
  assert.ok(inspection.entries.some(entry => entry.note.id === 'other'));
});

test('rests create real movement time and tuplets use performed duration', () => {
  const { project, selection } = setup([note('a', [60]), { id: 'r', kind: 'rest', value: { type: 'quarter', dots: 0 } }, note('b', [84])]);
  const prepared = Passage.prepare(project, selection).passage;
  assert.ok(prepared.steps[1].time - (prepared.steps[0].time + prepared.steps[0].attacks[0].duration) > 0.5);
  assert.equal(run(project, selection).assignments.length, 2);
  project.outline[2].data.upperStaff.voices[0].elements = [{ id: 'tuplet', kind: 'tuplet', actual: 3, normal: 2, baseType: 'eighth', elements: [note('x', [60]), note('y', [62]), note('z', [64])] }];
  const tuplets = Passage.prepare(project, { staff: 'upperStaff', noteIds: ['x', 'y', 'z'] }).passage;
  assert.ok(Math.abs(tuplets.steps[1].time - tuplets.steps[0].time - 0.2) < 1e-8);
});

test('complete ties share a finger, including anchors on continuations; partial ties expand and conflicting ties fail', () => {
  const { project, selection } = setup([note('a', [60], { tieTo: 'b' }), note('b', [{ midi: 60, fingering: 3 }], { tieFrom: 'a' }), note('c', [62])]);
  const draft = run(project, selection), applied = Editor.apply(project, selection, draft.assignments);
  assert.equal(fingers(applied, selection)[0][0], 3);
  assert.equal(fingers(applied, selection)[1][0], undefined);
  assert.deepEqual(Passage.prepare(project, { ...selection, noteIds: ['b', 'c'] }).issues, []);
  project.outline[2].data.upperStaff.voices[0].elements[0].pitches[0].fingering = 2;
  assert.match(Passage.prepare(project, selection).issues[0].message, /conflicting fingerings inside a tie/);
});

test('conflicting chord anchors and unsupported expressions produce diagnostics without changing notes', () => {
  for (const extra of [{ arpeggio: { type: 'normal', spreadRatio: 1, timing: 0 } }]) {
    const { project, selection } = setup([note('a', [60], extra)]), before = structuredClone(project);
    assert.ok(Passage.prepare(project, selection).issues.length);
    assert.deepEqual(project, before);
  }
  const { project, selection } = setup([note('a', [{ midi: 60, fingering: 5 }, { midi: 64, fingering: 1 }, 67])]);
  const result = Engine.calculate(Passage.prepare(project, selection).passage);
  assert.equal(result.candidates.length, 0); assert.match(result.issues[0].message, /fixed fingers/);
  const duplicate = setup([note('a', [{ midi: 60, fingering: 2 }, { midi: 64, fingering: 2 }, 67])]);
  assert.match(Passage.prepare(duplicate.project, duplicate.selection).issues[0].message, /more than one/);
  const substitution = setup([note('a', [{ midi: 60, fingering: 1, substitutionFingering: 2 }])]);
  assert.match(Passage.prepare(substitution.project, substitution.selection).issues[0].message, /substitutions/);
});

test('fill is atomic for incomplete, duplicate, out-of-range and anchor-changing drafts', () => {
  const { project, selection } = setup([note('a', [60]), note('b', [{ midi: 62, fingering: 2 }]), note('c', [64])]);
  const valid = run(project, selection).assignments;
  for (const draft of [valid.slice(0, 1), [valid[0], valid[0]], [...valid, { noteId: 'b', pitchIndex: 0, finger: 3 }],
    valid.map((item, i) => i ? item : { ...item, finger: 6 }), valid.map(item => ({ ...item, noteId: 'outside' }))])
    assert.strictEqual(Editor.apply(project, selection, draft), project);
});

test('clear removes ordinary, substitution and grace fingers only; apply and clear undo atomically', () => {
  const { project, selection } = setup([note('a', [{ midi: 60, fingering: 1, substitutionFingering: 2 }], { beforeGraceNotes: [{ id: 'g', pitches: [{ midi: 59, fingering: 3 }], value: { type: 'eighth', dots: 0 }, slash: true }] }), note('b', [{ midi: 62, fingering: 4 }])]);
  const before = structuredClone(project), onlyA = { ...selection, noteIds: ['a'] };
  const cleared = Editor.clear(project, onlyA), a = Timeline.note(cleared.outline, 'a').note;
  assert.deepEqual(a.pitches, [{ midi: 60 }]); assert.deepEqual(a.beforeGraceNotes[0].pitches, [{ midi: 59 }]);
  assert.equal(Timeline.note(cleared.outline, 'b').note.pitches[0].fingering, 4);
  assert.deepEqual(project, before);
  const plain = setup([note('x', [60]), note('y', [62])]);
  const snapshot = value => ({ project: value });
  const history = History.create(snapshot(plain.project));
  const filled = Editor.apply(plain.project, plain.selection, run(plain.project, plain.selection).assignments);
  history.record(snapshot(filled)); const empty = Editor.clear(filled, plain.selection); history.record(snapshot(empty));
  assert.strictEqual(history.undo().project, filled); assert.strictEqual(history.undo().project, plain.project);
  assert.strictEqual(history.redo().project, filled); assert.strictEqual(history.redo().project, empty);
});

test('clear expands shared trill spans and removes their sequence while preserving settings', () => {
  const { project, selection } = setup([note('a', [60], { tieTo: 'b' }), note('b', [60], { tieFrom: 'a' })]);
  project.trills = [{ id: 'trill', kind: 'trill', startNoteId: 'a', endNoteId: 'b', settings: { auxiliary: 'diatonic', start: 'main', attackCount: 4, fingerings: [1, 2, 1, 2] } }];
  const partial = { ...selection, noteIds: ['b'] };
  assert.equal(Selection.clearAvailability(project, partial).allowed, true);
  assert.equal(Editor.clear(project, partial).trills[0].settings.fingerings, undefined);
  assert.match(Passage.prepare(project, selection).issues[0].message, /Trills/);
  const cleared = Editor.clear(project, selection);
  assert.equal(cleared.trills[0].settings.fingerings, undefined); assert.equal(cleared.trills[0].settings.attackCount, 4);
  assert.equal(Selection.clearAvailability(cleared, selection).allowed, false);
});

test('Fingering submenu supports keyboard navigation and disables empty clears', () => {
  const { project, selection } = setup([note('a', [60])]);
  let items = createNoteMenuItems(project, selection.noteIds);
  const index = items.findIndex(item => item.label === 'Fingering');
  assert.deepEqual(controlNoteMenu([index], 'Enter', items).path, [index, 0]);
  assert.equal(controlNoteMenu([index, 0], 'Enter', items).action, 'auto-fingering');
  assert.equal(items[index].children[1].disabled, true);
  assert.equal(controlNoteMenu([index, 1], 'Enter', items).action, undefined);
  const applied = Editor.apply(project, selection, run(project, selection).assignments);
  items = createNoteMenuItems(applied, selection.noteIds);
  assert.equal(controlNoteMenu([index, 1], 'Enter', items).action, 'clear-fingering');
});

test('non-contiguous, mixed-voice and empty selections are rejected instead of expanded', () => {
  const { project, selection } = setup([note('a', [60]), note('b', [62]), note('c', [64])]);
  assert.match(Passage.prepare(project, { ...selection, noteIds: ['a', 'c'] }).issues[0].message, /continuous/);
  assert.ok(Passage.prepare(project, { ...selection, noteIds: [] }).issues.length);
  project.outline[2].data.upperStaff.voices.push({ id: 'v2', elements: [note('other', [67])] });
  assert.match(Passage.prepare(project, { ...selection, noteIds: ['a', 'other'] }).issues[0].message, /one voice/);
});
