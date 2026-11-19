import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, InstancedMesh, PerspectiveCamera, Points, Vector3, Box3 } from 'three';
import { createNoteStream, NOTE_LOOK_AHEAD, NOTE_FAR_Z, NOTE_PLANE_Y, NOTE_STRIKE_Z } from '../src/infra/motion/note-stream.ts';
import { createFallingNotes } from '../src/infra/motion/falling-notes.ts';
import { ANIMATION_LEAD_IN, inspectAnimation } from '../src/domain/performance/animation-performance.ts';
import { keys } from '../src/domain/motion/keyboard.ts';
import { fitCamera } from '../src/infra/motion/framing.ts';
import Factory from '../src/domain/score/score-project.ts';
import Measure from '../src/domain/score/score-measure.ts';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const event = (startSeconds, durationSeconds, midi = 60, hand = 'right') => ({ startSeconds, durationSeconds, pitches: [midi], sourceNoteId: 'note',
  performance: [{ hand, voice: '0', noteId: 'note', pitchIndex: 0, fingering: 1 }] });
const plan = events => ({ startPosition: 0, endPosition: 16, durationSeconds: 20, pedalInitiallyDown: false, pedalEvents: [], events });

test('bars arrive exactly at attack, remain at the line while held, and disappear at key release', () => {
  const stream = createNoteStream(plan([event(1, 0.5)])), onset = 1 + ANIMATION_LEAD_IN;
  const approaching = stream.framesAt(onset - 0.1)[0], attack = stream.framesAt(onset)[0];
  assert.ok(approaching.front < NOTE_STRIKE_Z); assert.equal(approaching.active, false);
  near(attack.front, NOTE_STRIKE_Z); assert.equal(attack.active, true);
  const holding = stream.framesAt(onset + 0.25)[0];
  near(holding.front, NOTE_STRIKE_Z); assert.ok(holding.back > attack.back);
  assert.deepEqual(stream.framesAt(onset + 0.5), []);
});

test('the visible window clips long holds and future tails, supports reverse seek, and excludes distant notes', () => {
  const stream = createNoteStream(plan([event(20, 1), event(0, 10, 48, 'left'), event(2, 4)]));
  const before = stream.framesAt(1), held = before.find(bar => bar.note.midi === 48);
  near(held.back, NOTE_FAR_Z); assert.equal(before.length, 2);
  stream.framesAt(21); assert.deepEqual(stream.framesAt(1), before);
  assert.equal(stream.framesAt(7).length, 1);
  assert.deepEqual(stream.framesAt(100), []);
  assert.ok(before.every(bar => bar.back >= NOTE_FAR_Z && bar.front <= NOTE_STRIKE_Z && bar.front > bar.back));
  assert.equal(createNoteStream(plan([event(NOTE_LOOK_AHEAD, 1)])).framesAt(ANIMATION_LEAD_IN).length, 0);
});

test('all 88 lanes align to key centers without horizontal overlap; per-pitch releases and hand identities survive', () => {
  const stream = createNoteStream(plan(keys.map(key => event(0, 1, key.midiNote, key.midiNote < 60 ? 'left' : 'right'))));
  for (const [index, note] of stream.notes.entries()) {
    near(note.x, keys[index].target[0]); assert.ok(note.width > 0);
    if (index) assert.ok(stream.notes[index - 1].x + stream.notes[index - 1].width / 2 < note.x - note.width / 2);
  }
  const chord = { ...event(0, 2), pitches: [60, 64], pitchDurationsSeconds: [0.5, 2] };
  const held = createNoteStream(plan([chord])).framesAt(ANIMATION_LEAD_IN + 1);
  assert.deepEqual(held.map(bar => bar.note.midi), [64]);
});

test('substitution produces one continuous visual bar and pedal does not lengthen it', () => {
  const project = Factory.create(), data = Measure.create({ cnt: 4, unit: 4 });
  data.upperStaff.voices[0].elements = [{ id: 'note', kind: 'note', value: { type: 'whole', dots: 0 },
    pitches: [{ midi: 60, fingering: 3, substitutionFingering: 4 }] }];
  data.pedalEvents = [{ id: 'pedal', offset: { numerator: 0, denominator: 1 }, action: 'start' }];
  project.outline.push({ id: 'measure', type: 'measure', data });
  const performance = inspectAnimation(project).performance;
  assert.equal(performance.notes.length, 2);
  const stream = createNoteStream(performance.playback);
  assert.equal(stream.notes.length, 1);
  near(stream.notes[0].end - stream.notes[0].start, performance.playback.events[0].durationSeconds);
  assert.deepEqual(stream.framesAt(stream.notes[0].end), []);
});

test('instanced rendering grows for a dense window, seeks deterministically, and restores hidden bars', () => {
  const scene = new Scene();
  const layer = createFallingNotes(scene);
  const performance = { playback: plan(Array.from({ length: 300 }, (_, i) => event(i / 1000, 2, 21 + i % 88))), notes: [], origins: [], duration: 20 };
  layer.update(performance, 0, true);
  const group = scene.children[0], pool = group.children.find(mesh => mesh instanceof InstancedMesh);
  assert.equal(pool.count, 300); assert.equal(pool.instanceMatrix.count, 512);
  const matrix = [...pool.instanceMatrix.array];
  layer.update(performance, 10, true); assert.equal(pool.count, 0);
  layer.update(performance, 0, true); assert.deepEqual([...pool.instanceMatrix.array], matrix);
  layer.update(performance, 0, false); assert.equal(group.visible, false);
  layer.update(performance, 0, true); assert.equal(group.visible, true);
  assert.equal(pool.count, 300);
  layer.update(undefined, 0, true); assert.equal(group.visible, false);
});

test('strike effects start in their lane, spread, replay on seek, and fade at key release', () => {
  const scene = new Scene(), layer = createFallingNotes(scene);
  const playback = plan([{ ...event(1, 2, 60, 'left'), keyHoldLimitsSeconds: [0.5] }]);
  const performance = { playback, notes: [], origins: [], duration: 20 };
  const onset = 1 + ANIMATION_LEAD_IN;
  const group = scene.children[0];
  const effects = group.children.find(object => object instanceof Points);
  const position = effects.geometry.getAttribute('position');
  const opacity = effects.geometry.getAttribute('opacity');
  const diameter = effects.geometry.getAttribute('diameter');
  const sparkle = effects.geometry.getAttribute('sparkle');
  const count = () => effects.geometry.drawRange.count;
  const frame = () => ({
    positions: [...position.array.slice(0, count() * 3)],
    opacities: [...opacity.array.slice(0, count())],
  });

  layer.update(performance, onset - 0.05, true);
  assert.equal(count(), 0);
  layer.update(performance, onset, true);
  assert.ok(count() > 5);
  const [{ x, width }] = createNoteStream(playback).notes;
  near(position.getZ(0), NOTE_STRIKE_Z);
  for (let index = 0; index < count(); index++) {
    assert.ok(position.getY(index) > NOTE_PLANE_Y);
    assert.ok(Math.abs(position.getX(index) - x) < width / 2);
  }

  layer.update(performance, onset + 0.33, true);
  const particles = Array.from({ length: count() - 1 }, (_, index) => index + 1);
  assert.ok(particles.some(index => position.getX(index) < x - width / 2));
  assert.ok(particles.some(index => position.getX(index) > x + width / 2));
  const mist = particles.filter(index => sparkle.getX(index) === 0);
  const glints = particles.filter(index => sparkle.getX(index) === 1);
  assert.ok(mist.length > 0 && glints.length > 0);
  assert.ok(Math.max(...mist.map(index => diameter.getX(index))) >
    2 * Math.min(...glints.map(index => diameter.getX(index))));

  const hold = onset + 0.34;
  layer.update(performance, hold, true);
  assert.ok(count() > 1);
  const held = frame();
  layer.update(performance, onset + 0.57, true);
  assert.ok(opacity.getX(0) < held.opacities[0]);
  layer.update(performance, onset + 0.90, true);
  assert.ok(count() > 0);
  layer.update(performance, onset + 1.10, true);
  assert.equal(count(), 0);
  assert.equal(group.children.find(object => object instanceof InstancedMesh).count, 1);

  layer.update(performance, hold, true);
  assert.deepEqual(frame(), held);
  layer.update(performance, hold, false);
  assert.equal(group.visible, false);
  layer.update(performance, hold, true);
  assert.deepEqual(frame(), held);
});

test('overview framing fits the note field and full keyboard within the same top camera', () => {
  const camera = new PerspectiveCamera(40, 1038 / 550, 0.001, 10);
  const bounds = new Box3(new Vector3(-0.8, -0.15, NOTE_FAR_Z - 0.03), new Vector3(0.8, 0.17, 0.5));
  fitCamera(camera, bounds, true);
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const p = new Vector3(x, y, z).project(camera);
    assert.ok(Math.abs(p.x) < 1 && Math.abs(p.y) < 1);
  }
});
