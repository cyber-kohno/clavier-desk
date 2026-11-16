import assert from 'node:assert/strict';
import { test } from 'node:test';
import Factory from '../src/domain/score/score-project.ts';
import Measure from '../src/domain/score/score-measure.ts';
import Timeline from '../src/domain/score/score-timeline.ts';
import Plan from '../src/domain/performance/score-playback-plan.ts';
import Range from '../src/domain/performance/animation-range.ts';
import Selection from '../src/state/animation-selection.ts';
import { inspectAnimation, animationAudio, ANIMATION_LEAD_IN } from '../src/domain/performance/animation-performance.ts';
import { generateAnimation } from '../src/service/playback/animation-generation.ts';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const range = (first, last = first) => ({ firstMeasureId: `m${first}`, lastMeasureId: `m${last}` });
function fixture() {
  const project = Factory.create();
  for (let i = 0; i < 3; i++) {
    const data = Measure.create({ unit: 4, cnt: 4 });
    data.upperStaff.voices[0].elements = [{ id: `n${i}`, kind: 'note', value: { type: 'whole', dots: 0 }, pitches: [{ midi: 60 + i * 2, ...(i === 2 ? {} : { fingering: i + 1 }) }] }];
    project.outline.push({ id: `m${i}`, type: 'measure', data });
  }
  return project;
}
const note = (project, index) => Timeline.note(project.outline, `n${index}`).note;

test('outline range mode selects only measure blocks, including one measure plus a section, in either direction', () => {
  const project = fixture(); project.outline.splice(3, 0, { id: 'section', type: 'section', data: { name: 'B' } });
  for (const cursor of [{ blockId: 'section', selectionAnchorBlockId: 'm0' }, { blockId: 'm0', selectionAnchorBlockId: 'section' }, { blockId: 'm0', selectionAnchorBlockId: 'm0' }])
    assert.deepEqual(Selection.resolve(project.outline, cursor, 'outline'), { range: range(0) });
  assert.deepEqual(Selection.resolve(project.outline, { blockId: 'm2', selectionAnchorBlockId: 'm0' }, 'outline').range, range(0, 2));
  assert.deepEqual(Selection.resolve(project.outline, { blockId: 'm1' }, 'outline'), { range: null });
  assert.deepEqual(Selection.resolve(project.outline, { blockId: 'm1', selectionAnchorBlockId: 'm0' }, 'timeline'), { range: null });
  assert.match(Selection.resolve(project.outline, { blockId: 'section', selectionAnchorBlockId: 'section' }, 'outline').error, /at least one measure/);
});

test('partial coverage ignores missing fingers outside the measures, uses original labels and preserves trailing rest time', () => {
  const project = fixture(), before = structuredClone(project);
  assert.ok(inspectAnimation(project).issues.length);
  const partial = inspectAnimation(project, range(1));
  assert.deepEqual(partial.issues, []); assert.equal(partial.scopeLabel, 'Measures 2–2');
  assert.equal(partial.attacks, 1); assert.equal(partial.assigned, 1);
  assert.deepEqual(partial.performance.playback.events.map(event => event.sourceNoteId), ['n1']);
  near(partial.performance.notes[0].time, ANIMATION_LEAD_IN);
  near(partial.performance.playback.durationSeconds, 2.4);
  near(partial.performance.duration, 2.4 + ANIMATION_LEAD_IN + 0.62);
  assert.match(partial.performance.origins[0].label, /Measure 2/);
  generateAnimation(partial.performance);
  const combined = inspectAnimation(project, range(0, 1));
  assert.deepEqual(combined.issues, []); assert.equal(combined.attacks, 2);
  near(combined.performance.playback.durationSeconds, 4.8);
  assert.deepEqual(project, before);
});

test('tempo, dynamics, fermata and pedal context are inherited while notes remain range-only', () => {
  const project = fixture();
  project.tempoChanges = [{ noteId: 'n0', bpm: 200 }];
  project.dynamicChanges = [{ noteId: 'n0', level: 'p', velocity: 45 }];
  note(project, 1).fermata = { lengthRatio: 2 };
  const measures = project.outline.filter(block => block.type === 'measure');
  measures[0].data.pedalEvents = [{ offset: { numerator: 0, denominator: 1 }, action: 'start' }];
  const partial = inspectAnimation(project, range(1)), audio = partial.performance.playback;
  assert.deepEqual(partial.issues, []); assert.equal(audio.events[0].velocity, 45);
  near(audio.durationSeconds, 2.4); // 1.2 s at inherited tempo, stretched by the selected fermata.
  assert.equal(audio.pedalInitiallyDown, true);
  assert.equal(audio.pedalEvents.length, 1); assert.equal(audio.pedalEvents[0].action, 'stop'); near(audio.pedalEvents[0].atSeconds, 2.4);
  const shifted = animationAudio(partial.performance);
  near(shifted.events[0].startSeconds, ANIMATION_LEAD_IN);
  near(shifted.pedalEvents[0].atSeconds, 2.4 + ANIMATION_LEAD_IN);
});

test('ties entering and leaving the range keep the head finger and are clipped at both boundaries', () => {
  const project = fixture();
  for (let i = 0; i < 3; i++) {
    const current = note(project, i); current.pitches = [{ midi: 60, ...(i === 0 ? { fingering: 3 } : {}) }];
    if (i) current.tieFrom = `n${i - 1}`;
    if (i < 2) current.tieTo = `n${i + 1}`;
  }
  const partial = inspectAnimation(project, range(1));
  assert.deepEqual(partial.issues, []); assert.equal(partial.attacks, 1);
  assert.equal(partial.performance.notes[0].finger, 3);
  near(partial.performance.notes[0].time, ANIMATION_LEAD_IN); near(partial.performance.notes[0].duration, 2.4);
  assert.deepEqual(partial.performance.playback.events[0].notationNoteIds, ['n1']);
  generateAnimation(partial.performance);
});

test('substitution timing comes from the complete hold, including carrying the receiving finger into a later range', () => {
  const project = fixture();
  for (let i = 0; i < 3; i++) {
    const current = note(project, i); current.pitches = [{ midi: 60, ...(i === 0 ? { fingering: 1, substitutionFingering: 2 } : {}) }];
    if (i) current.tieFrom = `n${i - 1}`;
    if (i < 2) current.tieTo = `n${i + 1}`;
  }
  const middle = inspectAnimation(project, range(1));
  assert.deepEqual(middle.issues, []);
  const receiving = middle.performance.notes.find(event => event.action === 'substitute');
  near(receiving.time, ANIMATION_LEAD_IN + 1.2); // Original midpoint 3.6 s minus selected start 2.4 s.
  const last = inspectAnimation(project, range(2));
  assert.equal(last.performance.notes.length, 1); assert.equal(last.performance.notes[0].finger, 2);
  assert.equal(last.performance.notes[0].action, undefined);
  near(last.performance.notes[0].duration, 2.4);
  generateAnimation(last.performance);
});

test('outside slur tails and conflicts do not become partial-range contacts or diagnostics', () => {
  const project = fixture();
  delete note(project, 0).pitches[0].fingering;
  project.slurs = [{ id: 's', startNoteId: 'n0', endNoteId: 'n1' }];
  const partial = inspectAnimation(project, range(1));
  assert.deepEqual(partial.issues, []); assert.equal(partial.attacks, 1);
  assert.equal(partial.performance.notes[0].midiNote, 62);
});

test('selected grace-note pre-roll is retained without expanding back to unrelated attacks', () => {
  const project = fixture();
  note(project, 1).beforeGraceNotes = [
    { id: 'grace', value: { type: 'eighth', dots: 0 }, slash: true, pitches: [{ midi: 61, fingering: 3 }] },
    { id: 'grace2', value: { type: 'eighth', dots: 0 }, slash: true, pitches: [{ midi: 63, fingering: 4 }] },
  ];
  note(project, 1).gracePerformance = { spreadRatio: 1, timing: 1 };
  const full = Plan.create(project, 0);
  assert.ok(full.events.find(event => event.graceNote).startSeconds < 2.4);
  const partial = inspectAnimation(project, range(1));
  assert.deepEqual(partial.issues, []); assert.equal(partial.attacks, 3);
  assert.ok(partial.performance.playback.events.some(event => event.graceNote));
  assert.ok(partial.performance.playback.events.every(event => event.sourceNoteId !== 'n0' && event.sourceNoteId !== 'n2'));
});

test('both staves and every voice inside selected measures participate; invalid and empty ranges never fall back to full score', () => {
  const project = fixture(), middle = project.outline.find(block => block.id === 'm1');
  middle.data.lowerStaff.voices[0].elements = [{ id: 'left', kind: 'note', value: { type: 'whole', dots: 0 }, pitches: [{ midi: 48, fingering: 5 }] }];
  middle.data.upperStaff.voices.push({ id: 'voice-1', elements: [{ id: 'v2', kind: 'note', value: { type: 'whole', dots: 0 }, pitches: [{ midi: 67 }] }] });
  const partial = inspectAnimation(project, range(1));
  assert.equal(partial.attacks, 3); assert.equal(partial.assigned, 2);
  assert.match(partial.issues[0].message, /voice 2/);
  assert.ok(partial.performance.notes.some(event => event.hand === 'left'));
  const invalid = inspectAnimation(project, range(2, 0));
  assert.equal(invalid.attacks, 0); assert.match(invalid.issues[0].message, /no longer exists/);
  middle.data.upperStaff.voices = [{ id: 'voice-0', elements: [{ id: 'rest-r', kind: 'measure-rest' }] }];
  middle.data.lowerStaff.voices[0].elements = [{ id: 'rest-l', kind: 'measure-rest' }];
  assert.match(inspectAnimation(project, range(1)).issues[0].message, /selected measures have no notes/);
});

test('rolled-chord pre-roll belonging to the first selected measure is included in both audio and motion', () => {
  const project = fixture();
  note(project, 1).pitches = [{ midi: 64, fingering: 3 }, { midi: 60, fingering: 1 }];
  note(project, 1).arpeggio = { type: 'normal', spreadRatio: 1, timing: 1 };
  const partial = inspectAnimation(project, range(1));
  assert.deepEqual(partial.issues, []); assert.equal(partial.attacks, 2);
  assert.ok(partial.performance.playback.durationSeconds > 2.4);
  partial.performance.notes.forEach((contact, index) => {
    near(contact.time, partial.performance.playback.events[index].startSeconds + ANIMATION_LEAD_IN);
  });
});
