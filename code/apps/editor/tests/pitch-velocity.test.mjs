import assert from 'node:assert/strict';
import { test } from 'node:test';
import Authoring from '../src/action/editor/score-authoring.ts';
import Editing from '../src/action/editor/score-editing.ts';
import NoteContinuation from '../src/domain/score/note-continuation.ts';
import NoteDuration from '../src/domain/score/note-duration.ts';
import NotePitches from '../src/domain/score/note-pitches.ts';
import Dynamics from '../src/domain/score/score-dynamics.ts';
import Hairpins from '../src/domain/score/score-hairpins.ts';
import Factory from '../src/domain/score/score-project.ts';
import Validator from '../src/domain/score/score-project-validator.ts';
import Timeline from '../src/domain/score/score-timeline.ts';
import Trill from '../src/domain/score/score-trill.ts';
import Plan from '../src/domain/performance/score-playback-plan.ts';
import { soundingVelocity } from '../src/domain/score/pitch-velocity.ts';
import { animationSequenceAt } from '../src/service/playback/animation-transport.ts';
import Input from '../src/state/velocity-offset-input.ts';
import { createTimelineCursor } from '../src/state/timeline-cursor.ts';

function fixture(pitches = ['C4', 'E4', 'G4']) {
  const project = Authoring.apply(Factory.create(), Authoring.createState(), [{
    type: 'create_score', settings: { meter: [4, 4], keyFifths: 0, tempo: 120 },
    measures: [{ upper: [[{ value: '4', pitches }, { value: '4', pitches }, { value: '2', rest: true }]] }],
  }]).project;
  const [first, next] = Timeline.notes(project.outline);
  const target = { staff: 'upperStaff', voiceIndex: 0, pitchIndex: 0, noteId: first.note.id };
  return { project, first, next, target };
}

test('the draft uses signed arithmetic, rolls digits, and only commits on a fresh press', () => {
  const press = (draft, key, extra = {}) => Input.control(draft, { key, ...extra });
  let draft = Input.create(9);
  assert.equal(draft.column, 'ones');
  draft = press(draft, 'ArrowUp').draft;
  assert.equal(draft.offset, 10);
  draft = press(press(draft, 'ArrowLeft').draft, 'ArrowLeft').draft;
  assert.equal(press(draft, 'ArrowDown').draft.offset, -10);
  assert.equal(press(Input.create(-9), 'ArrowUp').draft.offset, -8);
  assert.equal(press(Input.create(-50), 'ArrowDown').draft.offset, -50);
  assert.equal(press(Input.create(50), 'ArrowUp').draft.offset, 50);
  assert.equal(press(draft, 'Delete').draft.offset, 0);
  assert.equal(press(draft, 'v', { repeat: true }), undefined);
  assert.equal(press(draft, 'v', { ctrlKey: true }), undefined);
  assert.equal(press(draft, 'v').action, 'commit');
  assert.equal(press(draft, 'Enter').action, 'commit');
  assert.equal(press(draft, 'Escape').action, 'cancel');
});

test('held navigation selects pitches and skips tie continuations between notes', () => {
  const chord = ['C4', 'E4', 'G4'];
  const project = Authoring.apply(Factory.create(), Authoring.createState(), [{
    type: 'create_score', settings: { meter: [4, 4], keyFifths: 0, tempo: 120 },
    measures: [{ upper: [[{ value: '4', pitches: chord, tie: true }, { value: '4', pitches: chord },
      { value: '4', rest: true }, { value: '4', pitches: ['D5'] }]] }],
  }]).project;
  const [first, continuation, last] = Timeline.notes(project.outline);
  assert.equal(continuation.note.tieFrom, first.note.id);
  const cursor = { ...createTimelineCursor(), focusedNoteId: first.note.id, focusedPitchIndex: 0, pitch: 67 };
  const draft = Input.create(12);
  const move = (from, key) => Input.move(project, from, Input.control(draft, { key }, true));

  assert.equal(Input.control(draft, { key: 'ArrowDown' }).action, 'update');
  assert.equal(Input.control(draft, { key: 'ArrowRight', ctrlKey: true }, true), undefined);
  assert.equal(move(cursor, 'ArrowUp'), cursor);
  const lowerPitch = move(cursor, 'ArrowDown');
  assert.equal(lowerPitch.focusedNoteId, first.note.id);
  assert.equal(lowerPitch.focusedPitchIndex, 1);
  assert.equal(lowerPitch.pitch, 64);
  const nextNote = move(lowerPitch, 'ArrowRight');
  assert.equal(nextNote.focusedNoteId, last.note.id);
  assert.equal(nextNote.positionSixteenths, 12);
  assert.equal(move(nextNote, 'ArrowRight'), nextNote);
  assert.equal(move(nextNote, 'ArrowLeft').focusedPitchIndex, 0);
  assert.equal(move(nextNote, 'ArrowLeft').focusedNoteId, first.note.id);
});

test('range input starts at zero and overwrites every selected pitch independently of existing offsets', () => {
  const { project, first, next, target } = fixture();
  const previous = NotePitches.setVelocityOffset(
    NotePitches.setVelocityOffset(project, target, 40), { ...target, noteId: next.note.id, pitchIndex: 2 }, -7);
  const range = Input.createRange(previous, Timeline.notes(previous.outline));
  assert.deepEqual(range.draft, Input.create());
  assert.equal(range.unadjusted, 88);
  const updated = NotePitches.setRangeVelocityOffset(previous, target.staff, range.noteIds, -15);
  for (const { note } of Timeline.notes(updated.outline)) {
    assert.deepEqual(note.pitches.map(pitch => pitch.velocityOffset), [-15, -15, -15]);
  }
  assert.equal(first.note.pitches[0].velocityOffset, undefined);
  assert.equal(Timeline.note(previous.outline, target.noteId).note.pitches[0].velocityOffset, 40);
  assert.equal(NotePitches.setRangeVelocityOffset(updated, target.staff, range.noteIds, -15), updated);
  const cleared = NotePitches.setRangeVelocityOffset(updated, target.staff, range.noteIds, 0);
  assert.ok(Timeline.notes(cleared.outline).every(({ note }) =>
    note.pitches.every(pitch => !Object.hasOwn(pitch, 'velocityOffset'))));
});

test('range input compares velocities before clamping and excludes tie continuations and grace pitches', () => {
  const { project, first, next, target } = fixture(['C4']);
  first.note.beforeGraceNotes = [{
    id: 'range-grace', pitches: [{ midi: 62, velocityOffset: 8 }], value: { type: 'eighth', dots: 0 }, slash: false,
  }];
  first.note.accent = { velocityOffset: 10 };
  next.note.accent = { velocityOffset: 25 };
  const accented = Dynamics.set(project, first.note.id, 'f', 120);
  const notes = Timeline.notes(accented.outline);
  const velocity = Plan.createAttackVelocityLookup(accented);
  assert.deepEqual(notes.map(note => velocity(note, 0)), [130, 145]);
  assert.equal(Input.createRange(accented, notes).unadjusted, null);

  const tied = NoteContinuation.toggleAdjacent(accented, target);
  const tiedNotes = Timeline.notes(tied.outline);
  assert.equal(Input.createRange(tied, tiedNotes.slice(1)), undefined);
  const range = Input.createRange(tied, tiedNotes);
  assert.deepEqual([...range.noteIds], [first.note.id]);
  assert.equal(range.unadjusted, 130);
  const updated = NotePitches.setRangeVelocityOffset(tied, target.staff, new Set(tiedNotes.map(({ note }) => note.id)), 20);
  const [head, tail] = Timeline.notes(updated.outline);
  assert.equal(head.note.pitches[0].velocityOffset, 20);
  assert.equal(head.note.beforeGraceNotes[0].pitches[0].velocityOffset, 8);
  assert.equal(tail.note.pitches[0].velocityOffset, undefined);
});

test('chord velocities clamp after all additions and survive saving and animation seek', () => {
  let { project, first, target } = fixture();
  first.note.accent = { velocityOffset: 20 };
  project = Dynamics.set(project, target.noteId, 'f', 120);
  project = NotePitches.setVelocityOffset(project, target, -20);
  project = NotePitches.setVelocityOffset(project, { ...target, pitchIndex: 1 }, 50);
  project = JSON.parse(JSON.stringify(project));
  assert.equal(Validator.isValid(project), true);
  first = Timeline.note(project.outline, target.noteId);
  const unadjusted = Plan.createAttackVelocityLookup(project)(first, 0);
  assert.equal(unadjusted, 140);
  const plan = Plan.create(project, 0);
  assert.deepEqual(plan.events[0].pitchVelocities, [120, 127, 127]);
  assert.deepEqual(animationSequenceAt(plan, 0.1, 1).events.slice(0, 3).map(event => event.velocity), [120, 127, 127]);
  assert.equal(first.note.pitches[1].velocityOffset, 50);
  const cleared = NotePitches.setVelocityOffset(project, target, 0);
  assert.equal(Object.hasOwn(Timeline.note(cleared.outline, target.noteId).note.pitches[0], 'velocityOffset'), false);
  assert.equal(NotePitches.setVelocityOffset(project, target, 51), project);
  const quiet = Dynamics.set(NotePitches.setVelocityOffset(project, target, -50), target.noteId, 'ppp', 1);
  assert.equal(Plan.create(quiet, 0).events[0].pitchVelocities[0], 1);
});

test('tie creation and respelling discard only the continuation offsets', () => {
  const { project, next, target } = fixture();
  const tail = { ...target, noteId: next.note.id };
  const withHead = NotePitches.setVelocityOffset(project, target, 13);
  const withBoth = NotePitches.setVelocityOffset(withHead, tail, -24);
  const editorTie = NoteContinuation.toggleAdjacent(withBoth, target);
  const batchTie = Editing.apply(withBoth, Authoring.createState(), [
    { type: 'set_tie', fromNoteId: target.noteId, toNoteId: tail.noteId },
  ]).project;
  const normalized = NoteDuration.normalize(editorTie, target, 1, 1).project;
  for (const score of [editorTie, batchTie, normalized]) {
    const [head, ...continuations] = Timeline.notes(score.outline);
    assert.equal(head.note.pitches[0].velocityOffset, 13);
    assert.ok(continuations.length > 0);
    for (const { note } of continuations) {
      assert.equal(Object.hasOwn(note.pitches[0], 'velocityOffset'), false);
      assert.equal(NotePitches.setVelocityOffset(score, { ...tail, noteId: note.id }, 10), score);
    }
    assert.equal(Validator.isValid(score), true);
  }
  const split = NoteContinuation.toggleAdjacent(editorTie, target);
  assert.equal(Timeline.note(split.outline, tail.noteId).note.pitches[0].velocityOffset, undefined);
});

test('the displayed first attack matches playback for rolls, grace notes and trills', () => {
  const chord = fixture();
  chord.first.note.arpeggio = { type: 'normal', spreadRatio: 1, timing: 0 };
  let rolled = Hairpins.add(Dynamics.set(chord.project, chord.first.note.id, 'pp', 1), 0, 4);
  rolled = Hairpins.configure(rolled, rolled.hairpins[0].id, 'crescendo', 127);
  rolled = NotePitches.setVelocityOffset(rolled, chord.target, 5);
  const rolledNote = Timeline.note(rolled.outline, chord.target.noteId);
  const rollVelocity = Plan.createAttackVelocityLookup(rolled);
  assert.ok(rollVelocity(rolledNote, 0) > rollVelocity(rolledNote, 2));
  for (const event of Plan.create(rolled, 0).events.filter(event => event.rollAnchorSeconds !== undefined)) {
    const { pitchIndex } = event.performance[0];
    assert.equal(event.pitchVelocities?.[0] ?? event.velocity,
      soundingVelocity(rollVelocity(rolledNote, pitchIndex), rolledNote.note.pitches[pitchIndex].velocityOffset));
  }

  const single = fixture(['C4']);
  single.first.note.beforeGraceNotes = [{ id: 'grace', pitches: [{ midi: 62 }], value: { type: 'eighth', dots: 0 }, slash: false }];
  single.first.note.accent = { velocityOffset: 15 };
  const withGrace = NotePitches.setVelocityOffset(single.project, { ...single.target, graceNoteId: 'grace' }, -20);
  const graceNote = Timeline.note(withGrace.outline, single.target.noteId);
  assert.equal(Plan.createAttackVelocityLookup(withGrace)(graceNote, 0, 'grace'), 88);
  assert.deepEqual(Plan.create(withGrace, 0).events[0].pitchVelocities, [68]);

  const plain = fixture(['C4']);
  const trill = Trill.set(NotePitches.setVelocityOffset(plain.project, plain.target, -12),
    plain.target.noteId, { ...Trill.defaults, start: 'auxiliary' });
  const trillEvents = Plan.create(trill, 0).events.filter(event => event.performance[0].trillAttackIndex !== undefined);
  assert.ok(trillEvents.length > 1);
  assert.ok(trillEvents.every(event => event.pitchVelocities[0] === 76));
});
