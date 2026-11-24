import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { createProject, createMeasureData } from '../src/model/project.ts';
import EditTransaction from '../src/action/editor/edit-transaction.ts';
import NoteEditor from '../src/action/editor/note-editor.ts';
import NotePitches from '../src/domain/score/note-pitches.ts';
import FingeringSelection from '../src/domain/score/fingering-selection.ts';
import FingeringPassage from '../src/domain/performance/fingering-passage.ts';
import AutomaticFingering from '../src/domain/performance/automatic-fingering.ts';
import ScoreGlissando from '../src/domain/score/score-glissando.ts';
import Validator from '../src/domain/score/score-project-validator.ts';
import ScoreIntegrity from '../src/domain/score/score-integrity.ts';
import ScorePlaybackPlan from '../src/domain/performance/score-playback-plan.ts';
import { inspectAnimation, ANIMATION_LEAD_IN } from '../src/domain/performance/animation-performance.ts';
import { evaluate, keyDepth, prepareMotion } from '../src/domain/motion/motion.ts';
import { createNoteMenuItems, controlNoteMenu } from '../src/state/note-menu.ts';
import Import from '../src/infra/musicxml/import-musicxml.ts';
import Preview from '../src/infra/musicxml/preview-musicxml.ts';
import { glissandoEndpointLabel } from '../src/infra/notation/glissando-line.ts';
import ProjectFile from '../src/infra/tauri/project-file.ts';

globalThis.DOMParser = DOMParser;
const note = (id, midi, type = 'half', extra = {}) => ({ id, kind: 'note', value: { type, dots: 0 }, pitches: [{ midi }], ...extra });
const rest = (id, type = 'quarter') => ({ id, kind: 'rest', value: { type, dots: 0 } });
function projectOf(...measures) {
  const project = createProject();
  for (const [index, elements] of measures.entries()) {
    const data = createMeasureData({ cnt: 4, unit: 4 });
    data.upperStaff.voices[0].elements = elements;
    project.outline.push({ id: `measure-${index}`, type: 'measure', data });
  }
  return project;
}
const add = project => NoteEditor.connectGlissando(project, ['end', 'start']);
const command = (project, ids, action) => createNoteMenuItems(project, ids)
  .find(item => item.label === 'Glissando').children.find(item => item.action === action);
const preview = (project, index = 0) => Preview.create(project.outline, index, undefined, undefined, undefined, undefined, undefined, undefined, undefined, project.glissandi);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);

test('menu adds ordered, adjacent white single notes, saves them and removes by either endpoint', () => {
  const initial = projectOf([note('start', 60), note('end', 67)]);
  const items = createNoteMenuItems(initial, ['end', 'start']);
  const index = items.findIndex(item => item.label === 'Glissando');
  assert.deepEqual(controlNoteMenu([index], 'Enter', items).path, [index, 0]);
  assert.deepEqual(controlNoteMenu([index, 0], 'Enter', items), { path: null, action: 'add-glissando' });
  const project = add(initial);
  const [{ id, ...span }] = project.glissandi;
  assert.ok(id);
  assert.deepEqual(span, { start: { noteId: 'start', midi: 60 }, end: { noteId: 'end', midi: 67 }, lineType: 'wavy', keySet: 'white' });
  assert.equal(add(project), project);
  const saved = ProjectFile.parse(ProjectFile.serialize(project));
  assert.ok(Validator.isValid(saved));
  ScoreIntegrity.validate(saved);
  assert.deepEqual(saved, project);
  assert.equal(command(project, ['end'], 'remove-glissando').disabled, false);
  assert.deepEqual(controlNoteMenu([index, 1], 'Enter', createNoteMenuItems(project, ['end'])),
    { path: null, action: 'remove-glissando' });
  assert.deepEqual(NoteEditor.disconnectGlissando(project, ['start']).glissandi, []);
  assert.deepEqual(NoteEditor.disconnectGlissando(project, ['end']).glissandi, []);
  const removedPitch = structuredClone(project);
  removedPitch.outline[2].data.upperStaff.voices[0].elements[0].pitches[0].midi = 62;
  assert.equal(Validator.isValid(removedPitch), false);
  assert.deepEqual(EditTransaction.commitPitches(project, removedPitch).glissandi, []);
});

test('authored spans require different sounding white keys, true adjacency and untied attacks', () => {
  const fixtures = [
    [note('start', 60), note('end', 60)],
    [note('start', 60), note('end', 62)],
    [note('start', 61), note('end', 67)],
    [note('start', 60, 'quarter'), rest('gap'), note('end', 67)],
    [note('start', 60, 'quarter'), note('middle', 62, 'quarter'), note('end', 67)],
    [note('start', 60, 'half', { pitches: [{ midi: 64 }, { midi: 60 }] }), note('end', 67)],
    [note('start', 60, 'half', { tieFrom: 'other' }), note('end', 67)],
  ];
  for (const elements of fixtures) {
    const project = projectOf(elements);
    assert.equal(command(project, ['end', 'start'], 'add-glissando').disabled, true);
    assert.equal(add(project), project);
  }
  const across = add(projectOf([rest('lead', 'half'), note('start', 60)], [note('end', 67, 'whole')]));
  assert.equal(across.glissandi.length, 1);
  assert.equal(preview(across, 1).glissandi.length, 1);
  const clipped = inspectAnimation(across, { firstMeasureId: 'measure-0', lastMeasureId: 'measure-0' });
  assert.deepEqual(clipped.issues, []);
  assert.deepEqual(clipped.performance.playback.events.map(event => event.pitches[0]), [60, 62, 64, 65]);
  assert.doesNotThrow(() => prepareMotion(clipped.performance.notes));
});

test('adding a glissando clears endpoint and tied fingerings and blocks their re-entry', () => {
  const initial = projectOf([
    note('start', 60, 'half', { pitches: [{ midi: 60, fingering: 3, substitutionFingering: 2, velocityOffset: 4 }] }),
    note('end', 67, 'quarter', { pitches: [{ midi: 67, fingering: 4 }], tieTo: 'tail' }),
    note('tail', 67, 'quarter', { pitches: [{ midi: 67, fingering: 4 }], tieFrom: 'end' }),
  ]);
  const project = add(initial);
  const pitches = project.outline[2].data.upperStaff.voices[0].elements.map(element => element.pitches[0]);
  assert.deepEqual(pitches, [{ midi: 60, velocityOffset: 4 }, { midi: 67 }, { midi: 67 }]);
  assert.equal(initial.outline[2].data.upperStaff.voices[0].elements[0].pitches[0].fingering, 3);
  for (const noteId of ['start', 'end', 'tail']) {
    assert.equal(NotePitches.setFingering(project, { staff: 'upperStaff', noteId, pitchIndex: 0 }, 3, 2), project);
  }
  const legacy = { ...initial, glissandi: project.glissandi };
  assert.deepEqual(ScoreGlissando.clearFingerings(legacy).outline, project.outline);
  const oldMotion = inspectAnimation(legacy).performance.notes;
  assert.deepEqual(oldMotion, inspectAnimation(project).performance.notes);
  const notation = preview(legacy);
  assert.deepEqual(notation.glissandoLabels.map(glissandoEndpointLabel), ['Gl. S', 'Gl. E']);
  assert.doesNotMatch(notation.xml, /<fingering/);
  const removed = NoteEditor.disconnectGlissando(project, ['end']);
  assert.notEqual(NotePitches.setFingering(removed, { staff: 'upperStaff', noteId: 'end', pitchIndex: 0 }, 3), removed);
});

test('automatic fingering skips glissando notes and validates the fixed gesture with ordinary notes', () => {
  const project = add(projectOf([
    note('before', 57, 'quarter'), note('start', 60, 'quarter'), note('end', 67, 'quarter'), note('after', 71, 'quarter'),
  ]));
  const selection = { staff: 'upperStaff', noteIds: ['before', 'start', 'end', 'after'] };
  const inspection = FingeringSelection.inspect(project, selection);
  assert.deepEqual(inspection.performanceAttacks.map(entry => entry.noteId), ['before', 'after']);
  assert.equal(inspection.missing, 2);
  assert.equal(FingeringSelection.inspect(project, { ...selection, noteIds: ['start', 'end'] }).missing, 0);
  const { passage, issues } = FingeringPassage.prepare(project, selection);
  assert.deepEqual(issues, []);
  assert.deepEqual(passage.gestures.map(note => note.midiNote), [60, 62, 64, 65, 67]);
  const result = AutomaticFingering.calculate(passage);
  assert.deepEqual(result.issues, []);
  const assignments = result.candidates[0].assignments;
  assert.deepEqual(assignments.map(assignment => assignment.noteId), ['before', 'after']);
  assert.equal(FingeringSelection.apply(project, selection, [...assignments, { noteId: 'start', pitchIndex: 0, finger: 2 }]), project);
  const assigned = FingeringSelection.apply(project, selection, assignments);
  assert.deepEqual(inspectAnimation(assigned).issues, []);
  assert.doesNotThrow(() => prepareMotion(inspectAnimation(assigned).performance.notes));
});

test('arrival attacks once at the written onset and keeps its tied duration; seeking and 3D use the same sweep', () => {
  const project = add(projectOf([note('start', 72), note('end', 60, 'quarter', { tieTo: 'tail' }),
    note('tail', 60, 'quarter', { tieFrom: 'end' })]));
  const prepared = ScorePlaybackPlan.prepare(project);
  const events = prepared.create(0).events;
  assert.deepEqual(events.map(event => event.pitches[0]), [72, 71, 69, 67, 65, 64, 62, 60]);
  const arrival = prepared.clock.secondsAt(8);
  for (const [index, event] of events.entries()) close(event.startSeconds, index * arrival / 7);
  close(events.at(-1).durationSeconds, prepared.clock.secondsAt(16) - arrival);
  const partial = prepared.create(3).events;
  assert.ok(partial[0].pitches[0] < 72);
  assert.equal(partial[0].startSeconds, 0);
  assert.equal(partial.at(-1).pitches[0], 60);
  const { issues, performance } = inspectAnimation(project);
  assert.deepEqual(issues, []);
  const { notes } = prepareMotion(performance.notes);
  const positions = [];
  const poses = [];
  for (let i = 0; i < events.length - 1; i++) {
    const time = ANIMATION_LEAD_IN + events[i].startSeconds + arrival / 7 / 3;
    const frame = evaluate(notes, time, 'scale').right;
    assert.equal(frame.technique, 'glissando');
    assert.ok(keyDepth(frame, events[i].pitches[0]) > 0);
    positions.push(frame.position[0]);
    poses.push(frame.joints);
  }
  assert.ok(positions.every((x, i) => i === 0 || x < positions[i - 1]));
  for (const pose of poses) assert.deepEqual(pose, poses[0]);
  assert.equal(evaluate(notes, ANIMATION_LEAD_IN + arrival + 0.02, 'scale').right.active.midiNote, 60);
});

test('MusicXML keeps an unsupported chord span and reverse-document-order endpoints on their actual pitches', () => {
  const xml = `<score-partwise><part id="P1"><measure number="1">
    <attributes><divisions>1</divisions><staves>2</staves></attributes>
    <forward><duration>1</duration></forward>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><staff>1</staff>
      <notations><glissando type="stop"/></notations></note>
    <backup><duration>2</duration></backup>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><type>quarter</type><staff>2</staff></note>
    <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><type>quarter</type><staff>2</staff>
      <notations><glissando type="start" line-type="dotted">a &amp; b</glissando></notations></note>
    <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><voice>2</voice><type>quarter</type><staff>2</staff>
      <notations><glissando type="start" number="2"/></notations></note>
    </measure></part></score-partwise>`;
  const { project, warnings } = Import.parse(xml);
  assert.ok(Validator.isValid(project));
  assert.deepEqual(project.glissandi.map(span => [span.start.midi, span.end.midi, span.lineType, span.text, span.keySet]),
    [[64, 72, 'dotted', 'a & b', undefined]]);
  assert.ok(warnings.some(warning => warning.code === 'glissando-playback'));
  assert.ok(warnings.some(warning => warning.code === 'glissando-endpoint'));
  assert.ok(ScorePlaybackPlan.create(project, 0).events.every(event => !event.glissando));
  const output = preview(project).xml;
  assert.match(output, /<glissando type="start" number="1" line-type="dotted">a &amp; b<\/glissando>/);
  assert.deepEqual(Import.parse(output).project.glissandi.map(span => [span.start.midi, span.end.midi]), [[64, 72]]);
});

test('夢花火 measure 38 restores the label and descending 12 intermediate white keys', () => {
  const { project } = Import.parse(readFileSync(new URL('../../../../work/夢花火.musicxml', import.meta.url), 'utf8'));
  const [{ span, first, last, playbackReason }] = ScoreGlissando.ranges(project);
  assert.equal(playbackReason, '');
  assert.equal(span.text, 'gliss.');
  assert.deepEqual([span.start.midi, span.end.midi], [95, 72]);
  const events = ScorePlaybackPlan.create(project, first.onset).events;
  const run = events.filter(event => event.glissando?.id === span.id || event.glissandoArrival?.id === span.id);
  assert.deepEqual(run.map(event => event.pitches[0]), [95, 93, 91, 89, 88, 86, 84, 83, 81, 79, 77, 76, 74, 72]);
  const clock = ScorePlaybackPlan.prepare(project).clock;
  close(run.at(-1).startSeconds, clock.secondsAt(last.onset) - clock.secondsAt(first.onset));
  assert.equal(preview(project, 37).glissandi[0].text, 'gliss.');
});
