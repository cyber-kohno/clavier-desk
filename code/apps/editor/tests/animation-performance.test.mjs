import assert from 'node:assert/strict';
import { test } from 'node:test';
import Factory from '../src/domain/score/score-project.ts';
import Measure from '../src/domain/score/score-measure.ts';
import Timeline from '../src/domain/score/score-timeline.ts';
import RestSpelling from '../src/domain/score/rest-spelling.ts';
import Plan from '../src/domain/performance/score-playback-plan.ts';
import { inspectAnimation, animationAudio, ANIMATION_LEAD_IN } from '../src/domain/performance/animation-performance.ts';
import { generateAnimation, generateAnimationMotion } from '../src/service/playback/animation-generation.ts';
import { animationSequenceAt, createAnimationTransport } from '../src/service/playback/animation-transport.ts';
import { evaluate, keyDepth, performancePlanFor, restorePreparedMotion } from '../src/domain/motion/motion.ts';
import { planChord } from '../src/domain/motion/chords.ts';
import { keys } from '../src/domain/motion/keyboard.ts';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function fixture() {
  const project = Factory.create(), data = Measure.create({ cnt: 4, unit: 4 });
  const note = (id, midi, fingering) => ({ id, kind: 'note', value: { type: 'quarter', dots: 0 }, pitches: [{ midi, fingering }] });
  data.upperStaff.voices[0].elements = [note('r1', 60, 1), note('r2', 62, 2), ...RestSpelling.create(8, 8)];
  data.lowerStaff.voices[0].elements = [{ ...note('l1', 48, 5), value: { type: 'whole', dots: 0 } }];
  project.outline.push({ id: 'measure', type: 'measure', data });
  return project;
}

test('repeated chord plans preserve contact order and keep cached geometry private', () => {
  const contacts = [
    { midiNote: 60, finger: 1, target: keys.find(key => key.midiNote === 60).target },
    { midiNote: 64, finger: 3, target: keys.find(key => key.midiNote === 64).target },
  ];
  const first = planChord('right', contacts, 0.018, 0.01);
  const expected = structuredClone(first);
  first.position[0] += 1;
  first.contacts[0].target[2] += 1;

  const repeated = planChord('right', contacts, 0.018, 0.01);
  assert.deepEqual(repeated, expected);
  repeated.contacts.reverse();
  assert.deepEqual(planChord('right', contacts, 0.018, 0.01), expected);
  assert.deepEqual(planChord('right', [...contacts].reverse(), 0.018, 0.01).contacts,
    [...expected.contacts].reverse());
});

test('generation reports actual work and restores the motion graph after a worker round trip', () => {
  const project = fixture();
  Timeline.note(project.outline, 'r1').note.pitches.push({ midi: 64, fingering: 3 });
  const input = inspectAnimation(project).performance;
  const progress = [];
  const motion = generateAnimationMotion(input, value => progress.push(value));
  assert.deepEqual(progress.filter(p => p.phase === 'notes').map(p => [p.completed, p.total]),
    input.notes.map((_, index) => [index, input.notes.length]));
  assert.deepEqual(progress.find(p => p.phase === 'chords'), {
    phase: 'chords', completed: 0, total: 1, hand: 'right', firstMeasure: 1, lastMeasure: 1,
  });
  assert.equal(progress.find(p => p.phase === 'sharedKeys').hand, undefined);

  const restored = structuredClone(motion);
  restorePreparedMotion(restored);
  const rightGroup = restored.groups.right[0];
  const time = rightGroup.notes[0].time + 0.1;
  const pose = evaluate(restored.notes, time, 'scale').right;
  assert.deepEqual(pose, evaluate(motion.notes, time, 'scale').right);
  assert.equal(pose.active, restored.notes.find(note => note.hand === 'right'));
  assert.equal(pose.targets[0], rightGroup.plan.contacts[0].target);
  assert.equal(performancePlanFor(restored.notes), restored.plan);
});

test('animation uses the audio timeline, preserves identity and trailing rests, and never mutates notation', () => {
  const project = fixture();
  project.tempoChanges = [{ noteId: 'r2', bpm: 90 }];
  const before = structuredClone(project), inspected = inspectAnimation(project);
  assert.deepEqual(inspected.issues, []);
  assert.equal(inspected.assigned, 3);
  const generated = generateAnimation(inspected.performance), audio = animationAudio(generated);
  const plan = Plan.create(project, 0);
  for (const note of generated.notes) {
    const event = plan.events.find(event => event.pitches.includes(note.midiNote));
    near(note.time, event.startSeconds + ANIMATION_LEAD_IN);
    near(note.duration, event.durationSeconds);
  }
  assert.deepEqual(audio.events.map(e => e.startSeconds), plan.events.map(e => e.startSeconds + ANIMATION_LEAD_IN));
  near(generated.duration, ANIMATION_LEAD_IN + plan.durationSeconds + 0.62);
  assert.ok(generated.duration > Math.max(...generated.notes.filter(note => note.hand === 'right').map(note => note.time + note.duration)) + 1);
  assert.equal(generated.notes.find(note => note.midiNote === 48).hand, 'left');
  assert.equal(plan.events.find(e => e.sourceNoteId === 'r2').performance[0].noteId, 'r2');
  const time = generated.notes[0].time + 0.1;
  const frame = evaluate(generated.notes, time, 'scale', 'connected', 'smooth', true);
  evaluate(generated.notes, generated.duration, 'scale', 'connected', 'smooth', true);
  assert.deepEqual(evaluate(generated.notes, time, 'scale', 'connected', 'smooth', true), frame);
  assert.deepEqual(project, before);
});

test('a shared key passes between hands without simultaneous contact or changing audio', () => {
  const project = fixture(), measure = project.outline.at(-1).data;
  measure.upperStaff.voices[0].elements = [...RestSpelling.create(0, 4),
    { kind: 'note', id: 'incoming', value: { type: 'quarter', dots: 0 }, pitches: [{ midi: 60, fingering: 1 }] },
    ...RestSpelling.create(8, 8)];
  measure.lowerStaff.voices[0].elements = [
    { kind: 'note', id: 'outgoing', value: { type: 'quarter', dots: 0 },
      pitches: [{ midi: 60, fingering: 1 }, { midi: 55, fingering: 3 }] },
    ...RestSpelling.create(4, 12)];
  const before = structuredClone(project), inspected = inspectAnimation(project);
  const generated = generateAnimation(inspected.performance);
  const [left, right] = generated.notes.filter(n => n.midiNote === 60);
  const audio = animationAudio(generated).events.find(event => event.sourceNoteId === 'outgoing');
  near(right.time, left.time + audio.durationSeconds);
  near(right.time, left.time + left.duration + 0.01);
  for (let time = right.time - 0.012; time <= right.time + 0.004; time += 0.0005) {
    const frame = evaluate(generated.notes, time, 'scale');
    assert.ok(!['left', 'right'].every(hand => frame[hand].activeNotes.some(n => n.midiNote === 60)));
  }
  assert.deepEqual(project, before);
  const overlap = inspected.performance.notes.map(n => n.hand === 'right' ? { ...n, time: n.time - 0.02 } : n);
  assert.throws(() => generateAnimationMotion({ ...inspected.performance, notes: overlap }),
    /Simultaneous contact with the same key by both hands/);
});

test('coverage reports missing fingers on performed attacks with a score location', () => {
  const project = fixture();
  delete Timeline.note(project.outline, 'r2').note.pitches[0].fingering;
  const check = inspectAnimation(project);
  assert.equal(check.assigned, 2); assert.equal(check.attacks, 3);
  assert.equal(check.issues[0].noteId, 'r2'); assert.match(check.issues[0].message, /Measure 1, right hand.*MIDI 62/);
  assert.match(inspectAnimation(Factory.create()).issues[0].message, /no notes/);
});

test('graces, rolled chords and trills retain their own finger identities after tempo and fermata conversion', () => {
  const project = fixture(), first = Timeline.note(project.outline, 'r1').note, second = Timeline.note(project.outline, 'r2').note;
  first.beforeGraceNotes = [{ id: 'grace', value: { type: 'eighth', dots: 0 }, slash: true, pitches: [{ midi: 59, fingering: 2 }] }];
  first.fermata = { lengthRatio: 2 };
  second.pitches = [{ midi: 67, fingering: 5 }, { midi: 64, fingering: 3 }, { midi: 60, fingering: 1 }];
  second.arpeggio = { type: 'normal', spreadRatio: 1, timing: 0 };
  let check = inspectAnimation(project);
  assert.deepEqual(check.issues, []);
  assert.equal(check.performance.playback.events.find(e => e.graceNote).performance[0].noteId, 'grace');
  for (const event of check.performance.playback.events.filter(e => e.sourceNoteId.includes('-arpeggio-'))) {
    const pitch = second.pitches.find(p => p.midi === event.pitches[0]);
    assert.equal(event.performance[0].fingering, pitch.fingering);
    assert.equal(second.pitches[event.performance[0].pitchIndex].midi, pitch.midi);
  }
  second.pitches = [{ midi: 62 }]; delete second.arpeggio;
  project.trills = [{ id: 'trill', kind: 'trill', startNoteId: 'r2', endNoteId: 'r2',
    settings: { auxiliary: 'diatonic', start: 'main', attackCount: 4, fingerings: [2, 3, 2, 3] } }];
  check = inspectAnimation(project);
  assert.deepEqual(check.issues, []);
  assert.deepEqual(check.performance.playback.events.filter(e => e.sourceNoteId.includes('-trill-')).map(e => e.performance[0].fingering), [2, 3, 2, 3]);
  delete project.trills[0].settings.fingerings;
  assert.equal(inspectAnimation(project).issues.length, 4);
});

test('tied notes become one contact; explicit conflicting continuation fingers are rejected', () => {
  const project = fixture(), first = Timeline.note(project.outline, 'r1').note, second = Timeline.note(project.outline, 'r2').note;
  first.tieTo = second.id; second.tieFrom = first.id; second.pitches = [{ midi: 60 }];
  const check = inspectAnimation(project);
  assert.deepEqual(check.issues, []);
  assert.equal(check.performance.notes.filter(n => n.hand === 'right').length, 1);
  second.pitches[0].fingering = 2;
  assert.match(inspectAnimation(project).issues[0].message, /finger changes inside a tie/);
});

test('substitution defaults to the midpoint and holds the key without a second audio attack', () => {
  const project = fixture(), first = Timeline.note(project.outline, 'r1').note;
  first.pitches = [{ midi: 60, fingering: 3, substitutionFingering: 4 }];
  const check = inspectAnimation(project);
  assert.deepEqual(check.issues, []);
  const notes = check.performance.notes.filter(n => n.midiNote === 60);
  assert.equal(notes.length, 2); assert.equal(notes[1].action, 'substitute');
  const generated = generateAnimation(check.performance);
  for (const t of [notes[1].time - 0.001, notes[1].time, notes[0].time + notes[0].duration + 0.001])
    near(keyDepth(evaluate(generated.notes, t).right, 60), 1);
  assert.equal(animationAudio(generated).events.filter(e => e.pitches.includes(60)).length, 1);
});

test('a thumb substitution can finish before an octave while keeping the key depressed', () => {
  const project = fixture(), measure = project.outline.at(-1).data;
  project.outline[0].data.tempo = 118;
  const strike = (id, midi, finger, type, dots = 0) =>
    ({ kind: 'note', id, value: { type, dots }, pitches: [{ midi, fingering: finger }] });
  const held = strike('held-f', 77, 3, 'half', 1);
  held.pitches[0].substitutionFingering = 1;
  measure.upperStaff.voices[0].elements = [...RestSpelling.create(0, 4),
    strike('d6', 86, 5, 'eighth', 1), strike('e6', 88, 4, '16th'),
    strike('f6', 89, 5, 'quarter'), ...RestSpelling.create(12, 4)];
  measure.upperStaff.voices.push({ id: 'v1', elements: [held, strike('g5', 79, 1, 'quarter')] });
  const inspected = inspectAnimation(project);
  assert.deepEqual(inspected.issues, []);
  const generated = generateAnimation(inspected.performance);
  const [from, to] = generated.notes.filter(note => note.midiNote === 77);
  const melody = generated.notes.find(note => note.midiNote === 86);
  assert.equal(from.finger, 3);
  assert.equal(to.finger, 1);
  near(to.time, (from.time + melody.time) / 2);
  assert.ok(from.time + from.duration < melody.time);
  const audio = animationAudio(generated).events.filter(event => event.sourceNoteId === 'held-f');
  assert.equal(audio.length, 1);
  near(audio[0].durationSeconds, to.time + to.duration - from.time);
  for (let time = from.time + 0.061; time < to.time + to.duration; time += 0.00117) {
    near(keyDepth(evaluate(generated.notes, time).right, 77), 1);
  }
});

test('model limitations stop generation with an English reason and score location', () => {
  const project = fixture();
  Timeline.note(project.outline, 'r1').note.pitches = [{ midi: 60, fingering: 5 }, { midi: 64, fingering: 1 }];
  assert.throws(() => generateAnimation(inspectAnimation(project).performance), /Measure 1.*Crossed finger order/);
});

test('seeking restores held notes and pedal state and applies speed to both onset and release', () => {
  const performance = inspectAnimation(fixture()).performance;
  performance.playback.pedalEvents = [{ atSeconds: 0, action: 'start' }, { atSeconds: 1, action: 'change' }, { atSeconds: 2, action: 'stop' }];
  const audio = animationAudio(performance), at = ANIMATION_LEAD_IN + 0.2;
  const sequence = animationSequenceAt(audio, at, 0.5);
  assert.equal(sequence.pedalInitiallyDown, true);
  near(sequence.pedalEvents[0].atSeconds, 1.6);
  const held = sequence.events.find(e => e.pitches.includes(48));
  near(held.startSeconds, 0); near(held.durationSeconds, (performance.notes.find(n => n.midiNote === 48).duration - 0.2) / 0.5);
  assert.ok(sequence.events.every(e => e.startSeconds >= 0 && e.durationSeconds > 0));
});

test('transport follows the audio clock, pauses pending loads, ignores cancelled callbacks and resumes at changed speed', () => {
  let audioTime = 0, ready = false, callbacks, stopped = 0, wall = 0;
  const runs = [];
  const instrument = { stop() { stopped++; }, startSequence(sequence, handlers) {
    runs.push(sequence); callbacks = handlers;
    return { get ready() { return ready; }, get currentTime() { return audioTime; } };
  } };
  const transport = createAnimationTransport(instrument, assert.fail, () => wall);
  const sequence = animationAudio(inspectAnimation(fixture()).performance);
  transport.setSequence(sequence); transport.play(); wall = 100;
  near(transport.position, 0); ready = true; audioTime = 0.4; near(transport.position, 0.4);
  const cancelled = callbacks; transport.seek(1); cancelled.ended(); near(transport.position, 1);
  audioTime = 0; transport.play(); transport.setSpeed(0.5);
  near(runs.at(-1).durationSeconds, (sequence.durationSeconds - 1) / 0.5);
  audioTime = 0.2; near(transport.position, 1.1);
  transport.dispose(); assert.equal(transport.playing, false); assert.ok(stopped > 0);
});

test('silent transport advances without audio and catches a synchronous audio start failure', () => {
  let wall = 0;
  const sequence = animationAudio(inspectAnimation(fixture()).performance);
  const silent = createAnimationTransport(null, assert.fail, () => wall);
  silent.setSequence(sequence); silent.play(); wall = 0.7; near(silent.position, 0.7);
  silent.pause(); wall = 10; near(silent.position, 0.7);
  let failure;
  const broken = createAnimationTransport({ stop() {}, startSequence() { throw new Error('test failure'); } }, error => failure = error);
  broken.setSequence(sequence); broken.play();
  assert.equal(broken.playing, false); assert.match(failure.message, /test failure/);
});
