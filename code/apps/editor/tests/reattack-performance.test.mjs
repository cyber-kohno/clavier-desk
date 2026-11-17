import { test } from 'node:test';
import assert from 'node:assert/strict';
import Reattack from '../src/domain/performance/reattack-performance.ts';
import Project from '../src/domain/score/score-project.ts';
import Measure from '../src/domain/score/score-measure.ts';
import Plan, { keyHoldSeconds } from '../src/domain/performance/score-playback-plan.ts';
import Passage from '../src/domain/performance/fingering-passage.ts';
import Engine from '../src/domain/performance/automatic-fingering.ts';
import Editor from '../src/action/editor/fingering-editor.ts';
import { inspectAnimation } from '../src/domain/performance/animation-performance.ts';
import { generateAnimation } from '../src/service/playback/animation-generation.ts';
import { validate } from '../src/domain/motion/motion.ts';
import { MIN_REATTACK_GAP_SECONDS as gap } from '../src/domain/theory/performance-timing.ts';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const event = (time, duration, pitches = [60], voice = 'v1') => ({ startSeconds: time, durationSeconds: duration, pitches,
  sourceNoteId: String(time), performance: pitches.map((_, pitchIndex) => ({ hand: 'right', voice, noteId: String(time), pitchIndex })) });

test('same-key release is per pitch/voice, immutable and leaves onsets and unrelated contacts intact', () => {
  const input = [event(0, 0.13, [60, 64]), event(0.13, 0.13, [60]), event(0.2, 1, [64], 'v2')];
  const before = structuredClone(input), output = Reattack.apply(input);
  near(output[0].pitchDurationsSeconds[0], 0.12);
  near(output[0].pitchDurationsSeconds[1], 0.13);
  assert.deepEqual(output.map(e => e.startSeconds), [0, 0.13, 0.2]);
  assert.deepEqual(input, before);
  const slow = Reattack.apply([event(0, 1), event(1, 1)]);
  near(slow[0].durationSeconds, 0.95);
  const tooFast = Reattack.apply([event(0, 0.005), event(0.005, 1)]);
  near(tooFast[0].durationSeconds, 0.005); // Not hidden by shifting or fabricating a hold.
});

test('a same-hand voice handoff reserves key release without changing audio or real overlaps', () => {
  const ending = event(0, 1, [72, 76, 77]);
  ending.pitchDurationsSeconds = [1, 1.1, 1.2];
  ending.keyHoldLimitsSeconds = [1, 1.05, 1.2];
  const preceding = event(0.8, 0.2, [45], 'left');
  preceding.performance[0].hand = 'left';
  const input = [ending, preceding, event(1, 0.5, [71, 79], 'v2')];
  const before = structuredClone(input);
  const [voice, opposite, next] = Reattack.apply(input);
  near(keyHoldSeconds(voice, 0), 1 - gap);
  near(keyHoldSeconds(voice, 1), 1.05);
  near(keyHoldSeconds(voice, 2), 1.2);
  near(keyHoldSeconds(opposite, 0), 0.2);
  near(next.startSeconds, 1);
  assert.deepEqual(voice.pitchDurationsSeconds, [1, 1.1, 1.2]);
  assert.deepEqual(input, before);
});

test('118 BPM sixteenth repetitions, including slurred ones, share playable audio and motion timing', () => {
  for (const slurred of [false, true]) {
    const project = Project.create(), data = Measure.create({ cnt: 4, unit: 4 });
    project.outline[0].data.tempo = 118;
    data.upperStaff.voices[0].elements = Array.from({ length: 16 }, (_, i) => ({ id: `n${i}`, kind: 'note', value: { type: '16th', dots: 0 }, pitches: [{ midi: 76 }] }));
    project.outline.push({ id: 'm', type: 'measure', data });
    if (slurred) project.slurs = [{ id: 's', startNoteId: 'n0', endNoteId: 'n15' }];
    const plan = Plan.create(project, 0);
    for (let i = 0; i < 15; i++) {
      near(plan.events[i + 1].startSeconds, (i + 1) * 60 / 118 / 4);
      near(plan.events[i + 1].startSeconds - plan.events[i].startSeconds - plan.events[i].durationSeconds, gap);
    }
    const selection = { staff: 'upperStaff', noteIds: data.upperStaff.voices[0].elements.map(n => n.id) };
    const prepared = Passage.prepare(project, selection);
    assert.deepEqual(prepared.issues, []);
    const result = Engine.calculate(prepared.passage);
    assert.deepEqual(result.issues, []);
    const applied = Editor.apply(project, selection, result.candidates[0].assignments);
    const inspected = inspectAnimation(applied);
    assert.deepEqual(inspected.issues, []); generateAnimation(inspected.performance);
  }
});

test('repeated grace/principal keys reserve release time while ordinary ties remain a single hold', () => {
  const project = Project.create(), data = Measure.create({ cnt: 4, unit: 4 });
  data.upperStaff.voices[0].elements = [
    { id: 'a', kind: 'note', value: { type: 'half', dots: 0 }, pitches: [{ midi: 60 }],
      beforeGraceNotes: [{ id: 'g', pitches: [{ midi: 60 }], value: { type: '16th', dots: 0 }, slash: true }], tieTo: 'b' },
    { id: 'b', kind: 'note', value: { type: 'half', dots: 0 }, pitches: [{ midi: 60 }], tieFrom: 'a' },
  ];
  project.outline.push({ id: 'm', type: 'measure', data });
  const plan = Plan.create(project, 0);
  assert.equal(plan.events.length, 2);
  assert.equal(plan.events[0].graceNote, true);
  near(plan.events[1].startSeconds - plan.events[0].durationSeconds, gap);
  assert.ok(plan.events[1].durationSeconds > 1);
  const short = event(0, 0.04), following = event(0.13, 0.1);
  near(Reattack.apply([short, following])[0].durationSeconds, 0.04);
});

test('fast detached left-hand arpeggios validate on the first candidate and still require release before reuse', () => {
  const project = Project.create(), data = Measure.create({ cnt: 4, unit: 4 });
  project.outline[0].data.tempo = 118;
  const pitches = [55, 62, 59, 62, 55, 62, 59, 62, 55, 63, 60, 63, 55, 65, 62, 65];
  data.lowerStaff.voices[0].elements = pitches.map((midi, index) => ({
    id: `arpeggio-${index}`, kind: 'note', value: { type: '16th', dots: 0 }, pitches: [{ midi }],
  }));
  project.outline.push({ id: 'm', type: 'measure', data });
  const selection = { staff: 'lowerStaff', noteIds: data.lowerStaff.voices[0].elements.map(note => note.id) };
  const { passage, issues } = Passage.prepare(project, selection);
  assert.deepEqual(issues, []);
  let attempts = 0;
  const result = Engine.calculate(passage, progress => { if (progress.phase === 'validate') attempts++; });
  assert.deepEqual(result.issues, []);
  assert.equal(attempts, 1);

  const applied = Editor.apply(project, selection, result.candidates[0].assignments);
  const inspected = inspectAnimation(applied);
  assert.deepEqual(inspected.issues, []);
  const { notes } = generateAnimation(inspected.performance);
  assert.equal(notes.length, pitches.length);
  const [first, second] = notes;
  const silence = second.time - (first.time + first.duration);
  assert.ok(silence > 0 && silence < gap);
  assert.throws(() => validate([first, { ...second, finger: first.finger }]), /insufficient release time/);
  assert.throws(() => validate([first, { ...second, midiNote: first.midiNote }]), /insufficient release time/);
});
