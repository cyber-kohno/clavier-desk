import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Group, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fingers, pointsForPose } from '../src/domain/motion/fingers.ts';
import { evaluate, keyDepth, keys, prepareMotion, TRAVEL } from '../src/domain/motion/motion.ts';
import { FOREARM_LENGTH, forearmEndpoints, handPointWorld, WRIST } from '../src/domain/motion/movement.ts';
import { createPianoHands } from '../src/infra/motion/piano-hand.ts';

const asset = new URL('../src/infra/motion/assets/piano-hand-right.glb', import.meta.url);
const note = (time, midiNote, finger, hand) => ({ time, duration: 0.2, midiNote, finger, hand });
const tolerance = 0.00001;
const holdTimes = new Set([1.1, 1.4, 1.65, 2.2]);
const digitNames = ['thumb', 'index', 'middle', 'ring', 'little'];

test('both rigs share one model while following their own contacts and elbow guides', async () => {
  const bytes = await readFile(asset);
  const { scene } = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '',
  );
  const rigs = createPianoHands(scene);
  const leftSkin = rigs.left.root.getObjectByProperty('type', 'SkinnedMesh');
  const rightSkin = rigs.right.root.getObjectByProperty('type', 'SkinnedMesh');
  assert.equal(leftSkin.geometry, rightSkin.geometry);
  assert.equal(leftSkin.material, rightSkin.material);
  assert.notEqual(leftSkin.skeleton.bones[0], rightSkin.skeleton.bones[0]);

  // Reflect the passage around D in a lower octave. Its black/white pattern is symmetric.
  const rightNotes = [
    note(1, 60, 1, 'right'), note(1.3, 64, 3, 'right'), note(1.55, 66, 3, 'right'),
    note(2.1, 62, 1, 'right'), note(2.1, 66, 2, 'right'), note(2.1, 69, 5, 'right'),
  ];
  const { notes } = prepareMotion([...rightNotes, ...rightNotes.map(event => ({
    ...event, hand: 'left', midiNote: 112 - event.midiNote,
  }))]);
  const hands = { left: new Group(), right: new Group() };
  for (const side of ['left', 'right']) verifyHand(rigs[side], hands[side], notes, side);
  rigs.dispose();
  assert.equal(hands.left.children.length, 0);
  assert.equal(hands.right.children.length, 0);
});

function verifyHand(rig, hand, notes, side) {
  const scene = rig.root;
  const inward = side === 'right' ? 1 : -1;
  const forearmBone = scene.getObjectByProperty('name', 'forearmR');
  const wristBone = scene.getObjectByProperty('name', 'handR');
  const thumbBase = scene.getObjectByProperty('name', 'thumbcmcR').getWorldPosition(new Vector3());
  const thumbTip = rig.contacts[1].getWorldPosition(new Vector3());
  assert.ok(thumbBase.distanceTo(thumbTip) < 0.066, 'the thumb should have a compact bind pose');
  hand.add(scene);
  const wristPivot = new Vector3(...WRIST);

  const world = new Vector3();
  for (const time of [0, 0.93, 1, 1.1, 1.27, 1.34, 1.4, 1.55, 1.65, 2.1, 2.2, 2.3, 2.7, 1.1]) {
    const frame = evaluate(notes, time, 'scale', 'connected', 'smooth', true)[side];
    hand.rotation.set(...frame.rotation);
    hand.position.fromArray(frame.position).add(wristPivot)
      .sub(wristPivot.clone().applyQuaternion(hand.quaternion));
    const { wrist, elbow } = forearmEndpoints(frame.position, side, frame.forearmGuide);
    rig.pose(frame, new Vector3(...elbow).sub(new Vector3(...wrist)), hand.quaternion);
    hand.updateMatrixWorld(true);
    const shownForearm = forearmBone.getWorldPosition(new Vector3()).sub(wristBone.getWorldPosition(new Vector3()));
    const expectedForearm = new Vector3(...elbow).sub(new Vector3(...wrist));
    assert.ok(Math.abs(shownForearm.length() - FOREARM_LENGTH) < tolerance);
    assert.ok(shownForearm.distanceTo(expectedForearm) < tolerance);

    for (const finger of fingers) {
      const tip = pointsForPose(side, finger, frame.joints[finger])[2];
      const expected = handPointWorld(frame.position, frame.rotation, tip);
      rig.contacts[finger].getWorldPosition(world);
      if (finger === 1) {
        assert.ok(inward * (world.x - expected[0]) >= -tolerance, `thumb spread at ${time}`);
        if (time === 0) assert.ok(inward * (world.x - expected[0]) > 0.006, 'idle thumb should sit closer to the palm');
      } else {
        assert.ok(Math.abs(world.x - expected[0]) < tolerance, `finger ${finger} at ${time}`);
        if (!frame.activeNotes.some(note => note.finger === finger)) {
          assert.ok(world.z > expected[2] + 0.005, `${side} idle finger ${finger} remained extended at ${time}s`);
          assert.ok(fingerBend(scene, finger) >= 33.9 * Math.PI / 180,
            `${side} idle finger ${finger} is too straight at ${time}s`);
        }
      }
      assert.ok(world.z >= expected[2] - tolerance, `finger ${finger} moved toward the black keys at ${time}`);
      assert.ok(world.y >= expected[1] - tolerance, `finger ${finger} dropped below its planned height at ${time}`);
    }
    let hasSkin = false;
    scene.traverse(object => {
      if (!(object instanceof SkinnedMesh)) return;
      hasSkin = true;
      for (const bone of object.skeleton.bones) assert.ok(bone.matrixWorld.elements.every(Number.isFinite));
    });
    assert.ok(hasSkin);
    for (const [index, active] of frame.activeNotes.entries()) {
      if (time < active.time || time >= active.time + active.duration) continue;
      const surface = new Vector3(...frame.targets[index]);
      surface.y -= (frame.depths?.[index] ?? frame.depth) * TRAVEL;
      rig.contacts[active.finger].getWorldPosition(world);
      const key = keys.find(key => key.midiNote === active.midiNote);
      assert.ok(Math.hypot(world.x - surface.x, world.y - surface.y) < tolerance,
        `MIDI ${active.midiNote} at ${time}`);
      if (key.black) assert.ok(Math.abs(world.z - surface.z) < tolerance);
      else assert.ok(Math.abs(world.z - key.z) < key.length / 2);
      if (active.finger !== 1) {
        assert.ok(fingerBend(scene, active.finger) >= 23.9 * Math.PI / 180,
          `${side} finger ${active.finger} is too straight at ${time}s`);
      }
    }
    if (holdTimes.has(time)) {
      const surfaceBoxes = keys
        .map(key => ({ key, top: key.target[1] - keyDepth(frame, key.midiNote) * TRAVEL }));
      scene.traverse(object => {
        if (!(object instanceof SkinnedMesh) || object.userData.name !== 'Skin.R') return;
        for (let index = 0; index < object.geometry.attributes.position.count; index++) {
          object.localToWorld(object.getVertexPosition(index, world));
          assert.ok(surfaceBoxes.every(({ key, top }) =>
            Math.abs(world.x - key.target[0]) >= key.width / 2 ||
            Math.abs(world.z - key.z) >= key.length / 2 ||
            world.y < top - key.height ||
            world.y >= top - 0.0025),
          `skin penetrated a key by more than 2.5 mm at ${time} s`);
        }
      });
    }
  }
}

function fingerBend(scene, finger) {
  const digit = digitNames[finger - 1];
  const [base, pip, dip] = ['proximal', 'middle', 'distal'].map(part =>
    scene.getObjectByName(`${digit}${part}R`).getWorldPosition(new Vector3()));
  const axis = dip.clone().sub(base);
  const span = axis.length();
  axis.divideScalar(span);
  const up = new Vector3(0, 1, 0).addScaledVector(axis, -axis.y).normalize();
  const joint = pip.sub(base);
  const height = joint.dot(up);
  const along = joint.dot(axis);
  return Math.atan2(height, along) + Math.atan2(height, span - along);
}
