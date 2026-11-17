import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProject, createMeasureData } from '../src/model/project.ts';
import { createTimelineCursor } from '../src/state/timeline-cursor.ts';
import WorkspaceKeyboard from '../src/ui/keyboard/workspace-keyboard.ts';
import ScoreVoice from '../src/domain/score/score-voice.ts';
import ScoreProjectValidator from '../src/domain/score/score-project-validator.ts';

const holds = { rangeSelection: false, pitchSelection: false, diatonicMovement: false,
  octaveMovement: false, keySignatureEditing: false, noteNavigation: false, noteValueEditing: false,
  tempoEditing: false, measureLengthEditing: false, notePositionEditing: false, meterEditing: false };
function fixture() {
  const project = createProject();
  for (let i = 0; i < 2; i++) project.outline.push({ id: `m${i}`, type: 'measure', data: createMeasureData({ cnt: 4, unit: 4 }) });
  return { project, mode: 'outline', outlineCursor: { blockId: 'm0' }, timelineCursor: createTimelineCursor() };
}
function press(state, key, extra = {}, held = {}) {
  return WorkspaceKeyboard.control(state, { key, code: '', shiftKey: false, repeat: false, ...extra }, { ...holds, ...held });
}
function enter(state) { return press(state, 'ArrowDown', {}, { meterEditing: true, octaveMovement: true, notePositionEditing: true }); }
function note(id, midi = 60) { return { id, kind: 'note', pitches: [{ midi }], value: { type: 'whole', dots: 0 } }; }
function voice(id, element) { return { id: `voice-${id}`, elements: [element] }; }

test('inner entry clears the block range and overrides D meter handling only on measures', () => {
  const original = fixture();
  original.outlineCursor.selectionAnchorBlockId = 'm1';
  const before = structuredClone(original);
  let state = enter(original);
  assert.deepEqual(original, before);
  assert.equal(state.project, original.project);
  assert.deepEqual(state.outlineCursor, { blockId: 'm0', innerFocus: { staff: 'upperStaff', voiceIndex: 0 } });
  state = press(state, 'ArrowDown', { repeat: true }, { meterEditing: true });
  assert.equal(state.outlineCursor.innerFocus.staff, 'upperStaff');
  const emptyProject = createProject();
  const initial = { ...original, project: emptyProject, outlineCursor: { blockId: emptyProject.outline[0].id } };
  assert.equal(enter(initial).outlineCursor.innerFocus, undefined);
  assert.notDeepEqual(enter(initial).project.outline[0].data.timeSignature, initial.project.outline[0].data.timeSignature);
});

test('inner navigation clamps to existing voices and exits to the same measure', () => {
  let state = enter(fixture());
  state = press(state, 'a'); state = press(state, 'a');
  assert.equal(state.outlineCursor.innerFocus.voiceIndex, 2);
  assert.equal(press(state, 'ArrowRight').outlineCursor.innerFocus.voiceIndex, 2);
  state = press(state, 'ArrowDown');
  assert.deepEqual(state.outlineCursor.innerFocus, { staff: 'lowerStaff', voiceIndex: 0 });
  assert.equal(press(state, 'ArrowDown').outlineCursor.blockId, 'm0');
  assert.equal(press(state, 'ArrowLeft').outlineCursor.innerFocus.voiceIndex, 0);
  state = press(state, 'ArrowUp'); state = press(state, 'ArrowUp');
  assert.deepEqual(state.outlineCursor, { blockId: 'm0' });
  assert.deepEqual(press(enter(state), 'Escape').outlineCursor, { blockId: 'm0' });
});

test('A always appends, focuses the new voice and obeys the limit without repeating', () => {
  let state = enter(fixture());
  const untouched = state.project.outline[3];
  const first = state.project.outline[2].data.upperStaff.voices[0];
  state = press(state, 'a'); state = press(state, 'ArrowLeft'); state = press(state, 'a');
  assert.equal(state.project.outline.length, 4);
  assert.equal(state.project.outline[3], untouched);
  assert.equal(state.project.outline[2].data.lowerStaff.voices.length, 1);
  assert.equal(state.project.outline[2].data.upperStaff.voices[0], first);
  assert.equal(state.outlineCursor.innerFocus.voiceIndex, 2);
  assert.equal(state.project.outline[2].data.upperStaff.voices[2].elements[0].kind, 'measure-rest');
  assert.equal(press(state, 'a').project, state.project);
  assert.equal(press(enter(fixture()), 'a', { repeat: true }).project.outline[2].data.upperStaff.voices.length, 1);
});

test('Delete clears all notes and attachments, preserving the staff, independent events and neighbouring notes', () => {
  let state = fixture();
  const a = { ...note('a'), tieTo: 'b', beforeGraceNotes: [{ id: 'grace', pitches: [{ midi: 62 }], value: { type: 'eighth', dots: 0 }, slash: true }] };
  const b = { ...note('b'), tieFrom: 'a' };
  state.project.outline[2].data.upperStaff.voices[0] = voice(0, a);
  state.project.outline[3].data.upperStaff.voices[0] = voice(0, b);
  const pedalEvents = [{ id: 'pedal', offset: { numerator: 0, denominator: 1 }, action: 'start' }];
  const ottavaEvents = [{ id: 'ottava', offset: { numerator: 0, denominator: 1 }, staff: 'upperStaff', action: 'start' }];
  Object.assign(state.project.outline[2].data, { pedalEvents, ottavaEvents });
  Object.assign(state.project, { tempoChanges: [{ noteId: 'a', bpm: 80 }], dynamicChanges: [{ noteId: 'a', level: 'p', velocity: 75 }],
    clefChanges: [{ noteId: 'a', clef: 'bass' }], slurs: [{ id: 'slur', startNoteId: 'a', endNoteId: 'b' }] });
  const original = structuredClone(state.project);
  state = enter(state);
  assert.equal(press(state, 'Delete', { repeat: true }).project, state.project);
  const result = press(state, 'Delete');
  assert.equal(ScoreProjectValidator.isValid(result.project), true);
  assert.deepEqual(state.project, original);
  const measure = result.project.outline[2];
  assert.equal(measure.data.upperStaff.voices.length, 1);
  assert.equal(measure.data.upperStaff.voices[0].elements[0].kind, 'measure-rest');
  assert.equal(measure.data.pedalEvents, pedalEvents); assert.equal(measure.data.ottavaEvents, ottavaEvents);
  assert.deepEqual(result.project.outline[3].data.upperStaff.voices[0].elements, [note('b')]);
  for (const key of ['tempoChanges', 'dynamicChanges', 'clefChanges', 'slurs']) assert.deepEqual(result.project[key], []);
  assert.equal(result.timelineCursor.focusedNoteId, null);
});

test('voice removal renumbers local voices and detaches boundary ties without removing adjacent notes', () => {
  let state = fixture();
  for (let i = 0; i < 2; i++) {
    state.project.outline[i + 2].data.upperStaff.voices = [voice(0, note(`base${i}`, 48)),
      voice(1, { ...note(`t${i}`), ...(i === 0 ? { tieTo: 't1' } : { tieFrom: 't0' }) })];
  }
  state = enter(state);
  const before = structuredClone(state.project);
  const result = press(state, 'Delete', { shiftKey: true });
  assert.equal(ScoreProjectValidator.isValid(result.project), true);
  assert.deepEqual(state.project, before);
  assert.deepEqual(result.project.outline[2].data.upperStaff.voices, [voice(0, note('t0'))]);
  assert.deepEqual(result.project.outline[3].data.upperStaff.voices, [voice(0, note('base1', 48)), voice(1, note('t1'))]);
  assert.equal(result.outlineCursor.innerFocus.voiceIndex, 0);
  const blocked = press(result, 'Delete', { shiftKey: true });
  assert.equal(blocked.project, result.project); assert.equal(blocked.warning, 'last-voice');
  assert.deepEqual(blocked.project.outline[2].data.upperStaff.voices[0].elements, [note('t0')]);
});

test('R transfers the inner staff and voice to the timeline at the measure start', () => {
  let state = enter(fixture()); state = press(state, 'ArrowDown'); state = press(state, 'a');
  const result = press(state, 'r');
  assert.equal(result.mode, 'timeline'); assert.equal(result.timelineCursor.staff, 'lowerStaff');
  assert.equal(result.timelineCursor.voiceIndex, 1); assert.equal(result.timelineCursor.positionSixteenths, 0);
  assert.deepEqual(result.outlineCursor, { blockId: 'm0' });
});

test('pitch counts include chord, repetition, tied continuation, tuplets and grace pitches but exclude rests', () => {
  const a = { ...note('a'), pitches: [{ midi: 64 }, { midi: 60 }],
    beforeGraceNotes: [{ id: 'grace', pitches: [{ midi: 62 }], value: { type: 'eighth', dots: 0 }, slash: true }] };
  assert.equal(ScoreVoice.pitchCount({ id: 'voice-0', elements: [a, { ...note('b'), tieFrom: 'a' },
    { id: 'rest', kind: 'measure-rest' }, { id: 'tuplet', kind: 'tuplet', actual: 3, normal: 2, baseType: 'quarter',
      elements: [note('c'), { id: 'r', kind: 'rest', value: { type: 'quarter', dots: 0 } }, note('d')] }] }), 6);
});
