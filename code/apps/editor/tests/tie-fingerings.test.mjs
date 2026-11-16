import assert from 'node:assert/strict';
import { test } from 'node:test';
import Factory from '../src/domain/score/score-project.ts';
import Measure from '../src/domain/score/score-measure.ts';
import Timeline from '../src/domain/score/score-timeline.ts';
import Ties from '../src/domain/score/tie-fingerings.ts';
import Fingerings from '../src/domain/score/score-fingerings.ts';
import Continuation from '../src/domain/score/note-continuation.ts';
import Duration from '../src/domain/score/note-duration.ts';
import Deletion from '../src/domain/score/note-deletion.ts';
import Editor from '../src/action/editor/note-editor.ts';
import FingeringEditor from '../src/action/editor/fingering-editor.ts';
import Selection from '../src/domain/score/fingering-selection.ts';
import Passage from '../src/domain/performance/fingering-passage.ts';
import Engine from '../src/domain/performance/automatic-fingering.ts';
import Playback from '../src/domain/performance/score-playback-plan.ts';
import { inspectAnimation } from '../src/domain/performance/animation-performance.ts';
import { generateAnimation } from '../src/service/playback/animation-generation.ts';
import { createTimelineCursor } from '../src/state/timeline-cursor.ts';
import ProjectFile from '../src/infra/tauri/project-file.ts';
import Files from '../src/service/project/score-project-file-controller.ts';
import History from '../src/service/history/editor-history.ts';
import ScorePassage from '../src/domain/score/score-passage.ts';
import Editing from '../src/action/editor/score-editing.ts';
import Authoring from '../src/action/editor/score-authoring.ts';

function fixture(finger = 3, staff = 'upperStaff', chord = false) {
  const project = Factory.create();
  for (let i = 0; i < 3; i++) {
    const data = Measure.create({ unit: 4, cnt: 4 });
    data[staff].voices[0].elements = [{ id: `n${i}`, kind: 'note', value: { type: 'whole', dots: 0 },
      pitches: chord ? [{ midi: 67, ...(i === 0 && finger !== undefined ? { fingering: 5 } : {}) }, { midi: 60, ...(i === 0 && finger !== undefined ? { fingering: 1 } : {}) }]
        : [{ midi: 60, ...(i === 0 && finger !== undefined ? { fingering: finger } : {}) }],
      ...(i ? { tieFrom: `n${i - 1}` } : {}), ...(i < 2 ? { tieTo: `n${i + 1}` } : {}) }];
    project.outline.push({ id: `m${i}`, type: 'measure', data });
  }
  return project;
}
const get = (project, id, staff = 'upperStaff') => Timeline.note(project.outline, id, staff).note;
const target = (id, staff = 'upperStaff') => ({ noteId: id, staff, voiceIndex: 0, pitchIndex: 0 });
const cursor = (id, staff = 'upperStaff') => ({ ...createTimelineCursor(staff), focusedNoteId: id, focusedPitchIndex: 0 });
const selection = (staff = 'upperStaff') => ({ staff, noteIds: ['n0', 'n1', 'n2'] });

test('editing any tied member updates only its head, including substitutions and chord rules', () => {
  for (const staff of ['upperStaff', 'lowerStaff']) {
    const project = fixture(3, staff), before = structuredClone(project);
    const updated = Editor.setPitchFingering(project, cursor('n2', staff), 2, 4);
    assert.deepEqual(get(updated, 'n0', staff).pitches, [{ midi: 60, fingering: 2, substitutionFingering: 4 }]);
    assert.deepEqual(get(updated, 'n1', staff).pitches, [{ midi: 60 }]);
    assert.deepEqual(get(updated, 'n2', staff).pitches, [{ midi: 60 }]);
    assert.equal(Fingerings.owner(updated, 'n2', staff).pitches[0].fingering, 2);
    const playback = Playback.create(updated, 0);
    assert.equal(playback.events.length, 1); assert.equal(playback.events[0].performance[0].substitutionFingering, 4);
    assert.deepEqual(project, before);
  }
  const chord = fixture(3, 'upperStaff', true);
  assert.strictEqual(Editor.setPitchFingering(chord, cursor('n2'), 1), chord);
});

test('tie extension creates no duplicate fingers, while independent duplication inherits the initial finger', () => {
  const project = fixture();
  delete get(project, 'n0').tieTo;
  project.outline.splice(3); // Keep one measure, then add empty destination measures.
  for (let i = 1; i < 3; i++) project.outline.push({ id: `m${i}`, type: 'measure', data: Measure.create({ unit: 4, cnt: 4 }) });
  const extended = Continuation.after(project, target('n0'), { type: 'whole', dots: 0 }, true);
  assert.ok(extended);
  assert.equal(get(extended.project, 'n0').pitches[0].fingering, 3);
  assert.deepEqual(get(extended.project, extended.noteId).pitches, [{ midi: 60 }]);
  const duplicate = Continuation.after(extended.project, target(extended.noteId), { type: 'whole', dots: 0 }, false);
  assert.equal(get(duplicate.project, duplicate.noteId).pitches[0].fingering, 3);
});

test('rhythmic normalization treats absent continuation fingers as inheritance and stores only the head', () => {
  const project = fixture();
  const normalized = Duration.normalize(project, target('n2'), -1, 1);
  assert.ok(normalized);
  const chain = Timeline.tieChain(normalized.project.outline, normalized.noteId);
  assert.equal(chain[0].note.pitches[0].fingering, 3);
  assert.ok(chain.slice(1).every(entry => entry.note.pitches[0].fingering === undefined));
  assert.equal(chain.reduce((sum, entry) => sum + entry.lengthSixteenths, 0), 47);
});

test('splitting a tie or deleting its head gives the next attack its inherited initial finger', () => {
  const project = fixture();
  const split = Continuation.toggleAdjacent(project, target('n1'));
  assert.equal(get(split, 'n0').pitches[0].fingering, 3);
  assert.equal(get(split, 'n1').pitches[0].fingering, undefined);
  assert.equal(get(split, 'n2').pitches[0].fingering, 3);
  assert.deepEqual(Playback.create(split, 0).events.map(event => event.performance[0].fingering), [3, 3]);
  const deleted = Deletion.remove(project, target('n0'), ['n0']).project;
  assert.equal(get(deleted, 'n1').pitches[0].fingering, 3);
  assert.equal(get(deleted, 'n2').pitches[0].fingering, undefined);
  const middleDeleted = Deletion.remove(project, target('n1'), ['n1']).project;
  assert.equal(get(middleDeleted, 'n2').pitches[0].fingering, 3);
});

test('joining independent attacks rejects conflicting fingers and collapses matching duplicates', () => {
  const project = fixture();
  delete get(project, 'n0').tieTo; delete get(project, 'n1').tieFrom;
  get(project, 'n1').pitches[0].fingering = 2;
  assert.equal(Continuation.toggleAdjacent(project, target('n0')), undefined);
  get(project, 'n1').pitches[0].fingering = 3;
  const joined = Continuation.toggleAdjacent(project, target('n0'));
  assert.equal(get(joined, 'n0').pitches[0].fingering, 3);
  assert.equal(get(joined, 'n1').pitches[0].fingering, undefined);
});

test('automatic fingering counts one tied attack, emits one assignment and animates the full hold', () => {
  const project = fixture(); delete get(project, 'n0').pitches[0].fingering;
  const inspected = Selection.inspect(project, selection());
  assert.equal(inspected.entries.length, 3); assert.equal(inspected.attacks.length, 1);
  assert.equal(inspected.total, 1); assert.equal(inspected.missing, 1);
  const prepared = Passage.prepare(project, selection());
  assert.deepEqual(prepared.issues, []); assert.equal(prepared.passage.steps.length, 1);
  const draft = Engine.calculate(prepared.passage).candidates[0];
  assert.equal(draft.assignments.length, 1); assert.equal(draft.assignments[0].noteId, 'n0');
  const applied = FingeringEditor.apply(project, selection(), draft.assignments);
  assert.ok(get(applied, 'n0').pitches[0].fingering);
  assert.equal(get(applied, 'n1').pitches[0].fingering, undefined);
  assert.equal(get(applied, 'n2').pitches[0].fingering, undefined);
  const animation = inspectAnimation(applied);
  assert.deepEqual(animation.issues, []); assert.equal(animation.attacks, 1); assert.equal(animation.assigned, 1);
  assert.ok(Math.abs(animation.performance.notes[0].duration - 7.2) < 1e-7);
  generateAnimation(animation.performance);
});

test('legacy duplicates migrate immutably, while differing fingers and continuation-only substitutions survive as conflicts', () => {
  const project = fixture(), before = structuredClone(project);
  get(project, 'n1').pitches[0].fingering = 3; get(project, 'n2').pitches[0].fingering = 3;
  const original = structuredClone(project), canonical = Ties.normalize(project);
  assert.equal(get(canonical, 'n0').pitches[0].fingering, 3);
  assert.equal(get(canonical, 'n1').pitches[0].fingering, undefined);
  assert.deepEqual(project, original); assert.strictEqual(Ties.normalize(canonical), canonical);
  const continuationOnly = fixture(); delete get(continuationOnly, 'n0').pitches[0].fingering;
  get(continuationOnly, 'n2').pitches[0].fingering = 4;
  const moved = Ties.normalize(continuationOnly);
  assert.equal(get(moved, 'n0').pitches[0].fingering, 4); assert.equal(get(moved, 'n2').pitches[0].fingering, undefined);
  get(project, 'n2').pitches[0].fingering = 4;
  assert.strictEqual(Ties.normalize(project), project);
  assert.match(Passage.prepare(project, selection()).issues[0].message, /conflicting/);
  const substitution = structuredClone(before);
  get(substitution, 'n1').pitches[0] = { midi: 60, fingering: 3, substitutionFingering: 2 };
  assert.strictEqual(Ties.normalize(substitution), substitution);
  assert.equal(Ties.resolve(substitution, 'n0', 'upperStaff').conflicts.length, 1);
  const chord = fixture(3, 'upperStaff', true);
  delete get(chord, 'n0').pitches[1].fingering;
  get(chord, 'n1').pitches[1].fingering = 5;
  assert.strictEqual(Ties.normalize(chord), chord); // Combining individually valid partial annotations would reuse finger 5.
});

test('copying a detached tie suffix preserves one initial finger on its new head', () => {
  const project = fixture();
  const selected = Timeline.notes(project.outline).slice(1);
  const passage = ScorePassage.copy(project.outline, 'upperStaff', 0, selected);
  assert.equal(passage.atoms[0].element.pitches[0].fingering, 3);
  assert.equal(passage.atoms[1].element.pitches[0].fingering, undefined);
  project.outline.push({ id: 'm3', type: 'measure', data: Measure.create({ unit: 4, cnt: 4 }) });
  // Paste currently accepts one destination measure; a single detached member
  // becomes an independent attack and must retain its inherited finger too.
  const single = ScorePassage.copy(project.outline, 'upperStaff', 0, [selected[0]]);
  const pasted = ScorePassage.paste(project, 'upperStaff', 0, 48, single);
  assert.equal(pasted.ok, true);
  const chain = Timeline.tieChain(pasted.project.outline, pasted.noteIds[0]);
  assert.deepEqual(chain.map(entry => entry.note.pitches[0].fingering), [3]);
});

test('loading old projects removes only safe duplicates and preserves conflicting legacy annotations', async t => {
  const project = fixture(); get(project, 'n1').pitches[0].fingering = 3;
  t.mock.method(ProjectFile, 'openPath', async () => ({ path: 'old.clavierdesk', name: 'old.clavierdesk' }));
  t.mock.method(ProjectFile, 'read', async () => ProjectFile.serialize(project));
  const loaded = await Files.load(); assert.equal(loaded.type, 'success');
  assert.equal(get(loaded.value.project, 'n1').pitches[0].fingering, undefined);
  get(project, 'n1').pitches[0].fingering = 4;
  const conflict = await Files.load(); assert.equal(conflict.type, 'success');
  assert.equal(get(conflict.value.project, 'n1').pitches[0].fingering, 4);
});

test('clear requires a complete tie, clears the owner atomically and supports undo', () => {
  const project = fixture(), partial = { staff: 'upperStaff', noteIds: ['n2'] };
  assert.equal(Selection.clearAvailability(project, partial).allowed, false);
  assert.strictEqual(FingeringEditor.clear(project, partial), project);
  const history = History.create({ project });
  const cleared = FingeringEditor.clear(project, selection()); history.record({ project: cleared });
  assert.ok(selection().noteIds.every(id => get(cleared, id).pitches[0].fingering === undefined));
  assert.strictEqual(history.undo().project, project); assert.strictEqual(history.redo().project, cleared);
});

test('MCP batch edits share head ownership, chord checks, split inheritance and conflicting-join rejection', () => {
  const project = fixture(), edit = (p, operations) => Editing.apply(p, Authoring.createState(), operations).project;
  const updated = edit(project, [{ type: 'set_fingering', noteId: 'n2', pitchIndex: 0, fingering: 4 }]);
  assert.equal(get(updated, 'n0').pitches[0].fingering, 4); assert.equal(get(updated, 'n2').pitches[0].fingering, undefined);
  const split = edit(project, [{ type: 'set_tie', fromNoteId: 'n1', toNoteId: null }]);
  assert.equal(get(split, 'n2').pitches[0].fingering, 3);
  const chord = fixture(3, 'upperStaff', true);
  assert.throws(() => edit(chord, [{ type: 'set_fingering', noteId: 'n2', pitchIndex: 0, fingering: 1 }]), /already used/);
  const separate = fixture(); delete get(separate, 'n0').tieTo; delete get(separate, 'n1').tieFrom;
  get(separate, 'n1').pitches[0].fingering = 4;
  assert.throws(() => edit(separate, [{ type: 'set_tie', fromNoteId: 'n0', toNoteId: 'n1' }]), /conflicting fingerings/);
});
