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
  verifyBlackThumbChord(rigs, hands);
  rigs.dispose();
  assert.equal(hands.left.children.length, 0);
  assert.equal(hands.right.children.length, 0);
});

function verifyBlackThumbChord(rigs, hands) {
  // Measure 100 of the reported score, plus the same fingering reflected for the left hand.
  const rightNotes = [note(1, 54, 1, 'right'), note(1, 57, 2, 'right'), note(1, 62, 5, 'right')]
    .map(event => ({ ...event, duration: 2.25 }));
  const { notes } = prepareMotion([...rightNotes, ...rightNotes.map(event => ({
    ...event, hand: 'left', midiNote: 112 - event.midiNote,
  }))]);
  const blackKeys = keys.filter(key => key.black);
  const blackFront = blackKeys[0].z + blackKeys[0].length / 2;
  const wrist = new Vector3(...WRIST);
  for (const side of ['right', 'left']) {
    const hand = hands[side], rig = rigs[side];
    for (const time of [0.97, 1, 1.025, 1.05, 1.1, 1.5, 3.24, 3.28, 3.32]) {
      const frame = evaluate(notes, time, 'scale', 'connected', 'smooth', true)[side];
      hand.rotation.set(...frame.rotation);
      hand.position.fromArray(frame.position).add(wrist).sub(wrist.clone().applyQuaternion(hand.quaternion));
      const { wrist: guideWrist, elbow } = forearmEndpoints(frame.position, side, frame.forearmGuide);
      rig.pose(frame, new Vector3(...elbow).sub(new Vector3(...guideWrist)), hand.quaternion);
      hand.updateMatrixWorld(true);
      if (time >= 1 && time < 3.25) {
        for (const [index, active] of frame.activeNotes.entries()) {
          const contact = rig.contacts[active.finger].getWorldPosition(new Vector3());
          const [x, y, z] = frame.targets[index];
          const surface = y - (frame.depths?.[index] ?? frame.depth) * TRAVEL;
          assert.ok(Math.hypot(contact.x - x, contact.y - surface) < tolerance);
          if (active.finger === 1) assert.ok(Math.abs(contact.z - z) < tolerance);
          else assert.ok(contact.z < blackFront - 0.002, `${side} finger ${active.finger} did not enter the gap`);
          if (active.finger !== 1 && time === 1.1) {
            assert.ok(proximalPitch(rig.root, active.finger) < Math.PI / 6);
          }
        }
      }
      assertSkinClearsKeys(rig.root, blackKeys, frame, time);
    }
  }
}

function assertSkinClearsKeys(scene, checkedKeys, frame, time) {
  const world = new Vector3();
  const surfaceBoxes = checkedKeys.map(key => ({ key, top: key.target[1] - keyDepth(frame, key.midiNote) * TRAVEL }));
  scene.traverse(object => {
    if (!(object instanceof SkinnedMesh) || object.userData.name !== 'Skin.R') return;
    for (let index = 0; index < object.geometry.attributes.position.count; index++) {
      object.localToWorld(object.getVertexPosition(index, world));
      assert.ok(surfaceBoxes.every(({ key, top }) =>
        Math.abs(world.x - key.target[0]) >= key.width / 2 ||
        Math.abs(world.z - key.z) >= key.length / 2 ||
        world.y < top - key.height ||
        world.y >= top - 0.0025),
      `skin penetrated a key by more than 2.5 mm at ${time} s vertex ${index} point ${world.toArray()} bind ${object.geometry.attributes.position.getX(index)} / ${object.geometry.attributes.position.getZ(index)}`);
    }
  });
}

function verifyHand(rig, hand, notes, side) {
  const scene = rig.root;
  const inward = side === 'right' ? 1 : -1;
  const forearmBone = scene.getObjectByProperty('name', 'forearmR');
  const wristBone = scene.getObjectByProperty('name', 'handR');
  const bindWrist = wristBone.getWorldPosition(new Vector3());
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
      if (!frame.activeNotes.some(note => note.finger === finger)) {
        // Free fingers travel with the wrist when another finger reaches.
        const shift = wristBone.getWorldPosition(new Vector3()).sub(hand.localToWorld(bindWrist.clone()));
        expected[0] += shift.x;
        expected[2] += shift.z;
      }
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
          if (time === 0 || holdTimes.has(time)) {
            const knuckle = scene.getObjectByName(`${digitNames[finger - 1]}proximalR`).getWorldPosition(new Vector3());
            const middle = scene.getObjectByName(`${digitNames[finger - 1]}middleR`).getWorldPosition(new Vector3());
            assert.ok(knuckle.y > wristBone.getWorldPosition(new Vector3()).y + 0.008,
              `${side} idle knuckle ${finger} should rise above the wrist`);
            assert.ok(knuckle.y + 0.005 > middle.y, `${side} idle middle joint ${finger} curls upward at ${time}s (${middle.y-knuckle.y} m)`);
            assert.ok(world.y < knuckle.y, `${side} idle finger ${finger} points up`);
          }
        }
      }
      assert.ok(world.z >= expected[2] - tolerance, `finger ${finger} moved toward the black keys at ${time}`);
      if (frame.activeNotes.some(note => note.finger === finger)) {
        assert.ok(world.y >= expected[1] - tolerance, `finger ${finger} dropped below its planned height at ${time}`);
      }
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
    if (holdTimes.has(time)) assertSkinClearsKeys(scene, keys, frame, time);
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

function proximalPitch(scene, finger) {
  const digit = digitNames[finger - 1];
  const base = scene.getObjectByName(`${digit}proximalR`).getWorldPosition(new Vector3());
  const middle = scene.getObjectByName(`${digit}middleR`).getWorldPosition(new Vector3());
  return Math.asin(middle.sub(base).normalize().y * -1);
}

test('right-hand reaches use measured link lengths and independent knuckle correctives', async () => {
  const bytes = await readFile(asset);
  const { scene } = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const rigs = createPianoHands(scene);
  const skin = scene.getObjectByName('SkinR');
  const leftSkin = rigs.left.root.getObjectByName('SkinR');
  const spread = skin.morphTargetDictionary['Spread.outer'];
  assert.ok(Number.isInteger(spread));
  const hand = new Group();
  hand.add(scene);
  const chains = digitNames.map((digit, i) => (i === 0 ? ['cmc', 'proximal', 'distal'] : ['proximal', 'middle', 'distal'])
    .map(part => scene.getObjectByName(digit + part + 'R')).concat(rigs.right.contacts[i + 1]));
  const lengths = chain => chain.slice(1).map((bone, i) =>
    chain[i].getWorldPosition(new Vector3()).distanceTo(bone.getWorldPosition(new Vector3())));
  const rest = chains.map(lengths);
  const cases = [
    ...[0.9, 0.97, 1, 1.02, 1.1, 1.2, 1.23, 1.28, 1.34].map(time => ({
      events: [note(1, 60, 1, 'right'), note(1, 72, 5, 'right')], time, limit: 0.0055, spreadWeight: 1,
    })),
    { events: [note(1, 60, 2, 'right')], time: 1.1, limit: 0.0001, graduatedCurl: true },
    ...[[[60, 5]], [[60, 2], [64, 4], [67, 5]]].map(grip => ({
      events: grip.map(([midi, finger]) => note(1, midi, finger, 'right')),
      time: 1.1, graduatedCurl: true,
    })),
    { events: [60, 62, 64, 65, 67].map((midi, i) => note(0.4 + 0.2 * i, midi, [1, 2, 3, 1, 2][i], 'right')), time: 1.08, limit: 0.005 },
    ...[[61, 65, 73], [68, 72, 80]].flatMap(pitches => {
      const events = pitches.map((midi, i) => note(1, midi, [1, 3, 5][i], 'right'));
      return [0.94, 0.98, 1, 1.02, 1.1, 1.2, 1.23, 1.26, 1.28, 1.34].map(time => ({
        events, time, mixedOctave: true,
      }));
    }),
  ];
  for (const { events, time, limit, spreadWeight = 0, mixedOctave, graduatedCurl } of cases) {
    const frame = evaluate(prepareMotion(events).notes, time, 'scale', 'connected', 'smooth', true).right;
    hand.rotation.set(...frame.rotation);
    const pivot = new Vector3(...WRIST);
    hand.position.fromArray(frame.position).add(pivot).sub(pivot.clone().applyQuaternion(hand.quaternion));
    const { elbow, wrist } = forearmEndpoints(frame.position, 'right', frame.forearmGuide);
    rigs.right.pose(frame, new Vector3(...elbow).sub(new Vector3(...wrist)), hand.quaternion);
    hand.updateMatrixWorld(true);
    for (const active of frame.activeNotes) {
      const i = active.finger - 1;
      const pressingOctave = spreadWeight && keyDepth(frame, active.midiNote) > 0;
      const linkLimit = pressingOctave ? (active.finger === 1 ? 0.0001 : 0.002)
        : mixedOctave && time >= 1 && time <= 1.26 ? 0.0001 : limit;
      if (linkLimit !== undefined) {
        assert.ok(lengths(chains[i]).every((value, k) => Math.abs(value - rest[i][k]) < linkLimit),
          `link length outside reach tolerance for MIDI ${active.midiNote} at ${time}s`);
      }
      if (graduatedCurl) {
        const proximal = proximalPitch(scene, active.finger);
        const pip = chains[i][1].getWorldPosition(new Vector3());
        const dip = chains[i][2].getWorldPosition(new Vector3());
        const middle = Math.asin(pip.sub(dip).normalize().y);
        const pad = rigs.right.contacts[active.finger].getWorldPosition(new Vector3());
        const distal = Math.asin(dip.sub(pad).normalize().y);
        assert.ok(proximal < Math.PI / 6 && proximal < middle && middle < distal,
          `finger ${active.finger} should curl progressively toward the key`);
      }
      if (mixedOctave && keyDepth(frame, active.midiNote) > 0) {
        const at = frame.activeNotes.indexOf(active);
        const contact = rigs.right.contacts[active.finger].getWorldPosition(new Vector3());
        const [x, y, z] = frame.targets[at];
        assert.ok(Math.abs(contact.x - x) < tolerance);
        assert.ok(Math.abs(contact.y - (y - keyDepth(frame, active.midiNote) * TRAVEL)) < tolerance);
        if (active.finger !== 3) {
          assert.ok(Math.abs(contact.z - z) < tolerance);
        } else {
          const blackKey = keys.find(key => key.black);
          assert.ok(contact.z < blackKey.z + blackKey.length / 2);
        }
      }
      if (pressingOctave && active.finger === 5) {
        const pad = rigs.right.contacts[5].getWorldPosition(new Vector3());
        const padToJoint = chains[i][2].getWorldPosition(new Vector3()).sub(pad).normalize();
        assert.ok(padToJoint.y > Math.sin(18 * Math.PI / 180), `little finger lies flat at ${time}s`);
        assert.ok(fingerBend(scene, 5) >= 23.9 * Math.PI / 180);
      }
    }
    assert.ok(skin.morphTargetInfluences.some(weight => weight > 0));
    if (!mixedOctave) assert.equal(skin.morphTargetInfluences[spread], spreadWeight);
    assert.ok(leftSkin.morphTargetInfluences.every(weight => weight === 0));
    if (spreadWeight) {
      for (const [name, finger, midi] of [['thumb', 1, 60], ['little', 5, 72]]) {
        const index = skin.morphTargetDictionary[`Press.${name}`];
        assert.ok(Number.isInteger(index));
        const depth = keyDepth(frame, midi);
        assert.ok(Math.abs(skin.morphTargetInfluences[index] - depth) < tolerance);
        if (depth === 0) continue;
        const key = keys.find(key => key.midiNote === midi);
        const contact = rigs.right.contacts[finger].getWorldPosition(new Vector3());
        assert.ok(Math.abs(contact.y - (key.target[1] - depth * TRAVEL)) < tolerance);
        assert.ok(Math.abs(contact.x - key.target[0]) < key.width / 2);
        assert.ok(Math.abs(contact.z - key.z) < key.length / 2);
      }
    }
    assertSkinClearsKeys(scene, keys, frame, time);
  }
  rigs.dispose();
});
