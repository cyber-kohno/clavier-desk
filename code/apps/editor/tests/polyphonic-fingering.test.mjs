import { test } from 'node:test';
import assert from 'node:assert/strict';
import Project from '../src/domain/score/score-project.ts';
import Measure from '../src/domain/score/score-measure.ts';
import Selection from '../src/domain/score/fingering-selection.ts';
import Passage from '../src/domain/performance/fingering-passage.ts';
import Engine from '../src/domain/performance/automatic-fingering.ts';
import Editor from '../src/action/editor/fingering-editor.ts';
import { inspectAnimation } from '../src/domain/performance/animation-performance.ts';
import { evaluate } from '../src/domain/motion/motion.ts';
import { pointsForPose } from '../src/domain/motion/fingers.ts';
import { generateAnimation } from '../src/service/playback/animation-generation.ts';
const rest = (id, type) => ({ id, kind: 'rest', value: { type, dots: 0 } });
const note = (id, type, pitches, extra = {}) => ({ id, kind: 'note', value: { type, dots: 0 }, pitches, ...extra });
function fixture() {
  const project = Project.create(), data = Measure.create({ cnt: 4, unit: 4 });
  data.lowerStaff.voices = [
    { id: 'v0', elements: [rest('r0', 'quarter'), note('bass', 'quarter', [{ midi: 50 }], { tieTo: 'tail' }), note('tail', 'eighth', [{ midi: 50 }], { tieFrom: 'bass' }), rest('r1', 'eighth'), rest('r2', 'quarter')] },
    { id: 'v1', elements: [rest('r3', 'quarter'), note('chord', 'quarter', [{ midi: 60, fingering: 1 }, { midi: 57, fingering: 2 }, { midi: 53, fingering: 4 }]), note('moving', 'eighth', [{ midi: 59 }, { midi: 55 }]), rest('r4', 'eighth'), rest('r5', 'quarter')] },
  ];
  project.outline.push({ id: 'm', type: 'measure', data });
  return { project, selection: { staff: 'lowerStaff', noteIds: ['bass'] } };
}
test('expands ties and overlapping voices, searches held fingers jointly and applies all missing pitches', () => {
  const { project, selection } = fixture(), before = structuredClone(project);
  const inspection = Selection.inspect(project, selection);
  assert.deepEqual(inspection.issues, []);
  assert.equal(inspection.voiceCount, 2);
  assert.equal(inspection.addedNotes, 3);
  const prepared = Passage.prepare(project, selection);
  assert.deepEqual(prepared.issues, []);
  assert.equal(prepared.passage.steps.length, 2);
  assert.equal(prepared.passage.steps[0].attacks.length, 4);
  assert.equal(prepared.passage.steps[1].attacks.length, 3);
  const draft = Engine.calculate(prepared.passage);
  assert.deepEqual(draft.issues, []);
  assert.equal(draft.candidates[0].assignments.find(a => a.noteId === 'bass').finger, 5);
  const applied = Editor.apply(project, selection, draft.candidates[0].assignments);
  assert.equal(Selection.inspect(applied, selection).missing, 0);
  assert.deepEqual(project, before);
  const inspected = inspectAnimation(applied);
  assert.deepEqual(inspected.issues, []);
  const generated = generateAnimation(inspected.performance);
  const bass = generated.notes.find(note => note.midiNote === 50);
  for(let time=bass.time+0.061;time<bass.time+bass.duration-0.01;time+=0.01) {
    const frame=evaluate(generated.notes,time).left;
    assert.ok(frame.activeNotes.some(note=>note.midiNote===50));
    const tip=pointsForPose('left',5,frame.joints[5])[2];
    assert.ok(Math.abs(tip[1]+frame.position[1]+0.01)<1e-7);
    assert.ok([...frame.position,...Object.values(frame.joints).flatMap(pose=>Object.values(pose))].every(Number.isFinite));
  }
});
test('conflicting fixed fingers in separate voices fail instead of silently replacing anchors', () => {
  const { project, selection } = fixture();
  project.outline.at(-1).data.lowerStaff.voices[0].elements[1].pitches[0].fingering = 1;
  const before = structuredClone(project);
  const result = Engine.calculate(Passage.prepare(project, selection).passage);
  assert.equal(result.candidates.length, 0);
  assert.ok(result.issues.length); assert.deepEqual(project, before);
});

test('a held octave can use one fixed contact through descending black-key attacks', () => {
  const project = Project.create(), data = Measure.create({ cnt: 4, unit: 4 });
  project.outline[0].data.tempo = 118;
  const melody = [
    note('octave', 'quarter', [{ midi: 84 }], { value: { type: 'quarter', dots: 1 } }),
    note('flat', '16th', [{ midi: 82 }]), note('next', '16th', [{ midi: 80 }]),
    note('white', 'quarter', [{ midi: 79 }]), note('last', 'quarter', [{ midi: 78 }]),
  ];
  data.upperStaff.voices = [
    { id: 'v0', elements: melody },
    { id: 'v1', elements: [note('held', 'whole', [{ midi: 72 }])] },
  ];
  project.outline.push({ id: 'm', type: 'measure', data });
  const selection = { staff: 'upperStaff', noteIds: melody.map(n => n.id) };
  const result = Engine.calculate(Passage.prepare(project, selection).passage);
  assert.deepEqual(result.issues, []);
  assert.equal(result.candidates[0].assignments.length, 6);
  const applied = Editor.apply(project, selection, result.candidates[0].assignments);
  const inspected = inspectAnimation(applied);
  assert.deepEqual(inspected.issues, []);
  const { notes } = generateAnimation(inspected.performance);
  const held = notes.find(n => n.midiNote === 72);
  let target;
  for (let time = held.time + 0.061; time < held.time + held.duration; time += 0.00071) {
    const frame = evaluate(notes, time).right;
    const index = frame.activeNotes.indexOf(held);
    assert.ok(index >= 0);
    target ??= frame.targets[index];
    assert.deepEqual(frame.targets[index], target);
    const tip = pointsForPose('right', held.finger, frame.joints[held.finger])[2];
    assert.ok(Math.abs(tip[1] + frame.position[1] + 0.01) < 1e-7);
  }
});

test('auto fingering releases a shared key before a rolled chord in a second voice', () => {
  const project = Project.create(), data = Measure.create({ cnt: 4, unit: 4 });
  project.outline[0].data.tempo = 118;
  const roll = note('roll', 'quarter', [79, 74, 71, 67].map(midi => ({ midi })), {
    arpeggio: { type: 'normal', spreadRatio: 1, timing: 1 },
  });
  data.upperStaff.voices = [
    { id: 'v0', elements: [note('previous', 'quarter', [{ midi: 74 }]), rest('silence1', 'half')] },
    { id: 'v1', elements: [note('bass', 'quarter', [{ midi: 71 }]), roll, rest('silence2', 'half')] },
  ];
  project.outline.push({ id: 'm', type: 'measure', data });
  const selection = { staff: 'upperStaff', noteIds: ['bass', 'roll'] };
  const prepared = Passage.prepare(project, selection);
  assert.deepEqual(prepared.issues, []);
  const result = Engine.calculate(prepared.passage);
  assert.deepEqual(result.issues, []);
  assert.equal(result.candidates[0].assignments.length, 6);
  const inspected = inspectAnimation(Editor.apply(project, selection, result.candidates[0].assignments));
  assert.deepEqual(inspected.issues, []);
  const generated = generateAnimation(inspected.performance);
  const rollEvents = inspected.performance.playback.events.filter(event => event.rollAnchorSeconds !== undefined);
  assert.deepEqual(rollEvents.map(event => event.pitches[0]), [67, 71, 74, 79]);
  const [first, second] = generated.notes.filter(n => n.midiNote === 74);
  assert.ok(Math.abs(second.time - first.time - first.duration - 0.01) < 1e-8);
  const audio = inspected.performance.playback.events.find(event => event.sourceNoteId === 'previous');
  assert.ok(audio.durationSeconds > first.duration);
});

test('Clear includes overlapping voices, graces and substitutions', () => {
  const { project, selection } = fixture();
  const data = project.outline.at(-1).data;
  const bass = data.lowerStaff.voices[0].elements[1];
  bass.pitches[0].fingering = 1;
  bass.pitches[0].substitutionFingering = 5;
  data.lowerStaff.voices[1].elements[1].beforeGraceNotes = [{ id: 'grace', pitches: [{ midi: 59, fingering: 2 }], value: { type: '16th', dots: 0 }, slash: true }];
  data.upperStaff.voices[0].elements = [note('opposite', 'whole', [{ midi: 72, fingering: 3 }])];
  const later = Measure.create({ cnt: 4, unit: 4 });
  later.lowerStaff.voices[0].elements = [note('outside', 'whole', [{ midi: 48, fingering: 5 }])];
  project.outline.push({ id: 'later', type: 'measure', data: later });
  const before = structuredClone(project);
  const scope = Selection.scope(project, selection);
  assert.equal(scope.entries.length, 4);
  assert.equal(Selection.clearAvailability(project, selection).allowed, true);
  const cleared = Editor.clear(project, selection);
  const clearedScope = Selection.scope(cleared, selection);
  for(const { note } of clearedScope.entries) for(const pitch of [...note.pitches, ...(note.beforeGraceNotes ?? []).flatMap(grace => grace.pitches)]) {
    assert.equal(pitch.fingering, undefined);
    assert.equal(pitch.substitutionFingering, undefined);
  }
  assert.equal(cleared.outline[2].data.lowerStaff.voices[0].elements[1].tieTo, 'tail');
  assert.equal(cleared.outline[2].data.upperStaff.voices[0].elements[0].pitches[0].fingering, 3);
  assert.equal(cleared.outline.at(-1).data.lowerStaff.voices[0].elements[0].pitches[0].fingering, 5);
  assert.equal(Selection.clearAvailability(cleared, selection).allowed, false);
  assert.deepEqual(project, before);
});

test('Clear follows a directly overlapping tie across measures without expanding through its tail', () => {
  const project = Project.create();
  const before = Measure.create({ cnt: 4, unit: 4 });
  const selected = Measure.create({ cnt: 4, unit: 4 });
  before.lowerStaff.voices.push({ id: 'other', elements: [
    rest('silence', 'half'), note('head', 'half', [{ midi: 50, fingering: 5 }], { tieTo: 'tail' }),
  ] });
  before.lowerStaff.voices[0].elements = [
    note('outside', 'whole', [{ midi: 55, fingering: 2 }]),
  ];
  before.lowerStaff.voices.push({ id: 'third', elements: [
    note('overlaps-only-head', 'whole', [{ midi: 53, fingering: 3 }]),
  ] });
  selected.lowerStaff.voices[0].elements = [note('seed', 'quarter', [{ midi: 57 }])];
  selected.lowerStaff.voices.push({ id: 'other', elements: [
    note('tail', 'quarter', [{ midi: 50 }], { tieFrom: 'head' }),
    note('adjacent', 'quarter', [{ midi: 52, fingering: 4 }]),
  ] });
  project.outline.push({ id: 'before', type: 'measure', data: before },
    { id: 'selected', type: 'measure', data: selected });
  const selection = { staff: 'lowerStaff', noteIds: ['seed'] };
  const availability = Selection.clearAvailability(project, selection);
  assert.equal(availability.allowed, true);
  assert.deepEqual(availability.entries.map(entry => entry.note.id), ['head', 'seed', 'tail']);
  const cleared = Selection.clear(project, selection);
  const previousBar = cleared.outline.find(block => block.id === 'before').data;
  const selectedBar = cleared.outline.find(block => block.id === 'selected').data;
  assert.equal(previousBar.lowerStaff.voices[0].elements[0].pitches[0].fingering, 2);
  assert.equal(previousBar.lowerStaff.voices[1].elements[1].pitches[0].fingering, undefined);
  assert.equal(previousBar.lowerStaff.voices[2].elements[0].pitches[0].fingering, 3);
  assert.equal(selectedBar.lowerStaff.voices[1].elements[1].pitches[0].fingering, 4);
});
