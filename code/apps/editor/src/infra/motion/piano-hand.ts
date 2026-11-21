import { Bone, MeshStandardMaterial, Quaternion, SkinnedMesh, Vector3, type BufferGeometry, type Material, type Object3D } from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { fingers, pointsForPose, type Finger, type Hand } from '../../domain/motion/fingers.ts';
import { keys } from '../../domain/motion/keyboard.ts';
import { handPointWorld } from '../../domain/motion/movement.ts';
import { HOVER, TRAVEL, type HandFrame } from '../../domain/motion/motion.ts';

const digitNames = ['thumb', 'index', 'middle', 'ring', 'little'] as const;
const up = new Vector3(0, 1, 0);
const right = new Vector3(1, 0, 0);
const towardPlayer = new Vector3(0, 0, 1);
const palmClearance = 0.026;
// Keep the wrist raised and let the back of the hand rise further at the knuckles.
const wristRise = 0.0115;
const palmTilt = new Quaternion().setFromAxisAngle(right, 14 * Math.PI / 180);
const pressBendTangent = Math.tan(24 * Math.PI / 180);
const restBendTangent = Math.tan(34 * Math.PI / 180);
const restPadRetraction = 0.006;
const restPadDrop = 0.015;
const blackKey = keys.find(key => key.black)!;
const blackKeyFront = blackKey.z + blackKey.length / 2;
const whitePadDepth = blackKeyFront + 0.014;
const betweenBlackKeysDepth = blackKeyFront - 0.0035;

function canUseRearWhiteContact(frame: HandFrame, index: number) {
  const key = keys[frame.activeNotes[index].midiNote - keys[0].midiNote];
  const target = frame.targets[index];
  // Near a side of the white key, the planned point may not leave enough room
  // for the skin. The narrow slot is usable when the pad enters near the center.
  return key && !key.black && target[2] < blackKeyFront &&
    Math.abs(target[0] - key.target[0]) < 0.0015;
}

function joint(nodes: Map<string, Object3D>, name: string) {
  const bone = nodes.get(name);
  if (!(bone instanceof Bone)) throw new Error(`Missing piano hand bone: ${name}`);
  const position = bone.getWorldPosition(new Vector3());
  const rotation = bone.getWorldQuaternion(new Quaternion());
  return { bone, position, rotation };
}

type Joint = ReturnType<typeof joint>;

// Distance along one side of a triangle to the perpendicular from its third vertex.
function projection(distance: number, first: number, second: number) {
  return (distance * distance + first * first - second * second) / (2 * distance);
}

export function disposePianoHandModels(...roots: Object3D[]) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const skeletons = new Set<SkinnedMesh['skeleton']>();
  for (const root of roots) {
    root.traverse(object => {
      if (!(object instanceof SkinnedMesh)) return;
      geometries.add(object.geometry);
      skeletons.add(object.skeleton);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
      }
    });
    root.removeFromParent();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const material of materials) material.dispose();
}

export function createPianoHands(root: Object3D) {
  const models = [root];
  try {
    const materials = new Set<MeshStandardMaterial>();
    root.traverse(object => {
      if (!(object instanceof SkinnedMesh)) return;
      // A posed hand can move outside its bind-pose bounds.
      object.frustumCulled = false;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof MeshStandardMaterial) materials.add(material);
      }
    });
    for (const material of materials) material.color.multiplyScalar(0.84);
    // Geometry and materials stay shared, while each hand gets its own bones.
    const leftModel = clone(root);
    models.push(leftModel);
    const right = createPianoHand(root, 'right');
    const left = createPianoHand(leftModel, 'left');
    return { left, right, dispose() { disposePianoHandModels(...models); } };
  } catch (error) {
    disposePianoHandModels(...models);
    throw error;
  }
}

function createPianoHand(root: Object3D, side: Hand) {
  const mirror = side === 'left' ? -1 : 1;
  root.updateMatrixWorld(true);
  const nodes = new Map<string, Object3D>();
  // GLTFLoader sanitizes Object3D names for animation track paths.
  root.traverse(object => nodes.set(object.userData.name ?? object.name, object));
  const forearm = joint(nodes, 'forearm.R');
  const palm = joint(nodes, 'hand.R');
  const palmRotation = palmTilt.clone().multiply(palm.rotation);
  const forearmAxis = palm.position.clone().sub(forearm.position);
  const forearmLength = forearmAxis.length();
  forearmAxis.normalize();

  const digits = fingers.map(finger => {
    const name = digitNames[finger - 1];
    const [upper, middle, distal] = (finger === 1 ? ['cmc', 'proximal', 'distal'] : ['proximal', 'middle', 'distal'])
      .map(part => joint(nodes, `${name}.${part}.R`));
    const contact = nodes.get(`Contact.${name}.R`);
    if (!contact || contact.parent !== distal.bone) throw new Error(`Missing piano hand contact: ${name}`);
    const upperAxis = middle.position.clone().sub(upper.position);
    const middleAxis = distal.position.clone().sub(middle.position);
    const padAxis = contact.getWorldPosition(new Vector3()).sub(distal.position);
    return {
      finger, upper, middle, distal, contact,
      lengths: [upperAxis.length(), middleAxis.length(), padAxis.length()],
      upperAxis: upperAxis.normalize(), middleAxis: middleAxis.normalize(), padAxis: padAxis.normalize(),
    };
  });
  // Measure the authored right hand before reflecting the left instance.
  // The solver can then use the same joint axes and thumb motion on both sides.
  root.scale.x *= mirror;

  const armRoot = new Vector3();
  const armRotation = new Quaternion();
  const lift = new Vector3();
  const localTowardPlayer = new Vector3();
  const palmPoint = new Vector3();
  const knucklePoint = new Vector3();
  const elbowDirection = new Vector3();
  const aim = new Vector3();
  const normal = new Vector3();
  const pad = new Vector3();
  const guide = new Vector3();
  const thumbKnuckle = new Vector3();
  const firstJoint = new Vector3();
  const secondJoint = new Vector3();
  const middleAim = new Vector3();
  const lowerAim = new Vector3();
  const distalAim = new Vector3();
  const padDirection = new Vector3();
  const forearmInverse = new Quaternion();
  const inverse = new Quaternion();
  const upperRotation = new Quaternion();
  const middleRotation = new Quaternion();
  const distalRotation = new Quaternion();

  // Solved axes use the hand group's coordinates. Convert each bone to its
  // parent's local transform so even the offset finger pad lands on the target.
  function place(bone: Joint, point: Vector3, rotation: Quaternion, parentPoint: Vector3, parentRotation: Quaternion) {
    inverse.copy(parentRotation).invert();
    bone.bone.position.copy(point).sub(parentPoint).applyQuaternion(inverse);
    bone.bone.quaternion.copy(inverse).multiply(rotation);
  }

  function preserveFingerBend(bendTangent: number) {
    // The base and the joint nearest the pad are already placed. Raise the
    // middle joint only as far as needed to keep a downward bend between them.
    aim.copy(secondJoint).sub(knucklePoint);
    const span = aim.length();
    if (span < 1e-8) return;
    aim.divideScalar(span);
    guide.copy(firstJoint).sub(knucklePoint);
    const along = guide.dot(aim);
    if (along <= 0 || along >= span) return;
    normal.copy(lift).addScaledVector(aim, -lift.dot(aim));
    if (normal.lengthSq() < 1e-10) return;
    normal.normalize();

    // For the two links, tan(bend) = span * height / (along * remaining - height²).
    const area = along * (span - along);
    const height = 2 * bendTangent * area /
      (span + Math.sqrt(span * span + 4 * bendTangent ** 2 * area));
    firstJoint.addScaledVector(normal, Math.max(0, height - guide.dot(normal)));
  }

  function poseDigit(digit: typeof digits[number], pose: HandFrame, blackThumbChord: boolean) {
    const { finger, upper, middle, distal, lengths } = digit;
    const angles = pose.joints[finger];
    const [knuckle, , target] = pointsForPose('right', finger, angles);
    const active = pose.activeNotes.findIndex(note => note.finger === finger);
    pad.fromArray(target);
    let hover = 1;
    let whiteContact = 0;
    const behindBlackKeys = blackThumbChord && active !== -1 && finger !== 1 && canUseRearWhiteContact(pose, active);
    if (active !== -1) {
      const surface = pose.targets[active][1] - (pose.depths?.[active] ?? pose.depth) * TRAVEL;
      const [, height, depth] = handPointWorld(pose.position, pose.rotation, [mirror * target[0], target[1], target[2]]);
      const progress = Math.max(0, Math.min(1, (height - surface) / HOVER));
      hover = progress * progress * (3 - 2 * progress);
      // Keep a little room at the front of the slots between the black keys.
      // Other contacts keep the clearance used for ordinary white-key strikes.
      const key = keys.find(key => key.midiNote === pose.activeNotes[active].midiNote);
      if (key && !key.black) {
        whiteContact = 1 - hover;
        pad.addScaledVector(localTowardPlayer, Math.max(0, (behindBlackKeys ? betweenBlackKeysDepth : whitePadDepth) - depth) * whiteContact);
      }
    }
    // Keep the fleshy model clear of adjacent keys. Only release the extra
    // clearance at contact, when the pad must follow the key's actual depth.
    pad.addScaledVector(lift, hover);
    if (finger === 1) {
      // Relax the thumb back toward the hand in its hanging pose. Fade this
      // out during approach so the same point still meets the key on contact.
      pad.x += hover * Math.min(0.009, Math.max(0, upper.position.x - target[0] - 0.022));
      pad.z += hover * Math.min(0.010, Math.max(0, knuckle[2] - target[2] - 0.024));
    } else {
      // Retract and lower free fingertips slightly. The offset fades to zero
      // as each finger approaches the key, independently of the other fingers.
      pad.addScaledVector(localTowardPlayer, restPadRetraction * hover);
      pad.addScaledVector(lift, -restPadDrop * hover / palmClearance);
    }
    knucklePoint.copy(upper.position).sub(palm.position).applyQuaternion(palmTilt).add(palmPoint);
    aim.copy(pad).sub(knucklePoint);
    const reach = aim.length();
    aim.multiplyScalar(1 / Math.max(reach, 1e-8));
    if (reach < 1e-8) aim.copy(digit.upperAxis);

    guide.copy(up);
    if (finger === 1) guide.multiplyScalar(0.035).add(thumbKnuckle.fromArray(knuckle).sub(upper.position));
    normal.copy(guide).addScaledVector(aim, -guide.dot(aim));
    if (normal.lengthSq() < 1e-8) normal.copy(right).addScaledVector(aim, -right.dot(aim));
    normal.normalize();

    let [first, second, end] = lengths;
    // Couple the two distal links while retaining the previous planner's overall curl.
    const restCurl = finger === 1 ? 0 : 0.13 * hover;
    const bend = Math.max(0.12, Math.min(1.12, 0.32 + restCurl + 0.52 * (angles.distal - angles.proximal)));
    let remaining = Math.hypot(second + end * Math.cos(bend), end * Math.sin(bend));
    if (reach > first + remaining) {
      if (finger === 1) {
        // Absorb extra reach into the metacarpal under the palm. Extending
        // the two exposed phalanges makes the thumb visibly too long.
        first = reach - remaining;
      } else {
        const extension = reach / (first + remaining);
        first *= extension;
        second *= extension;
        end *= extension;
        remaining *= extension;
      }
    }
    // Unusually folded thumb poses can bring the pad inside the nominal reach.
    first = Math.max(remaining - reach, Math.min(remaining + reach, first));
    const along = projection(Math.max(reach, 1e-8), first, remaining);
    const height = Math.sqrt(Math.max(0, first * first - along * along));
    firstJoint.copy(knucklePoint).addScaledVector(aim, along).addScaledVector(normal, height);

    // Keep the thumb knuckle clear of the adjacent raised white key.
    if (finger === 1) firstJoint.addScaledVector(lift, 0.22 * whiteContact);
    lowerAim.copy(pad).sub(firstJoint).normalize();
    middleAim.crossVectors(aim, normal).cross(lowerAim).normalize();
    const middleAlong = projection(remaining, second, end);
    const middleHeight = Math.sqrt(Math.max(0, second * second - middleAlong * middleAlong));
    secondJoint.copy(firstJoint).addScaledVector(lowerAim, middleAlong).addScaledVector(middleAim, middleHeight);
    distalAim.copy(pad).sub(secondJoint).normalize();
    // As the key travels below its neighbors, bring the pad down with the
    // last segment closer to the direction of the key instead of sideways.
    if (whiteContact > 0) {
      const downward = finger === 1 ? 1.06 : behindBlackKeys ? 0.6 : 0.5;
      padDirection.copy(localTowardPlayer).negate().addScaledVector(lift, -downward / palmClearance).normalize();
      const alignment = finger === 1 ? 0.78 : behindBlackKeys ? 1 : 0.7;
      distalAim.lerp(padDirection, alignment * whiteContact).normalize();
    }
    if (finger !== 1 && hover > 0) {
      padDirection.copy(localTowardPlayer).negate().addScaledVector(lift, -1.6 / palmClearance).normalize();
      distalAim.lerp(padDirection, 0.38 * hover).normalize();
    }

    // Use the actual pad length. Extensions move the distal joint, keeping the
    // skin and nail aligned with their real contact node even at full reach.
    secondJoint.copy(pad).addScaledVector(distalAim, -lengths[2]);
    if (finger !== 1) preserveFingerBend(pressBendTangent + (restBendTangent - pressBendTangent) * hover);
    middleAim.copy(secondJoint).sub(firstJoint).normalize();
    upperRotation.setFromUnitVectors(digit.upperAxis, aim.copy(firstJoint).sub(knucklePoint).normalize()).multiply(upper.rotation);
    middleRotation.setFromUnitVectors(digit.middleAxis, middleAim).multiply(middle.rotation);
    distalRotation.setFromUnitVectors(digit.padAxis, distalAim).multiply(distal.rotation);
    place(upper, knucklePoint, upperRotation, palmPoint, palmRotation);
    place(middle, firstJoint, middleRotation, knucklePoint, upperRotation);
    place(distal, secondJoint, distalRotation, firstJoint, middleRotation);
  }

  return {
    root,
    contacts: Object.fromEntries(digits.map(digit => [digit.finger, digit.contact])) as Record<Finger, Object3D>,
    pose(frame: HandFrame, elbowFromWrist: Vector3, groupRotation: Quaternion) {
      forearmInverse.copy(groupRotation).invert();
      lift.copy(up).applyQuaternion(forearmInverse).multiplyScalar(palmClearance);
      localTowardPlayer.copy(towardPlayer).applyQuaternion(forearmInverse);
      elbowDirection.copy(elbowFromWrist).applyQuaternion(forearmInverse).normalize();
      lift.x *= mirror;
      localTowardPlayer.x *= mirror;
      elbowDirection.x *= mirror;
      palmPoint.copy(palm.position).addScaledVector(lift, 1 + wristRise / palmClearance);
      const thumb = frame.activeNotes.findIndex(note =>
        note.finger === 1 && keys[note.midiNote - keys[0].midiNote]?.black);
      const blackThumbChord = thumb !== -1 && frame.activeNotes.some((_, index) =>
        index !== thumb && canUseRearWhiteContact(frame, index));
      if (blackThumbChord) {
        const tip = pointsForPose(side, 1, frame.joints[1])[2];
        const [, height] = handPointWorld(frame.position, frame.rotation, tip);
        const surface = frame.targets[thumb][1] - (frame.depths?.[thumb] ?? frame.depth) * TRAVEL;
        const contact = 1 - Math.min(1, Math.max(0, (height - surface) / HOVER));
        // Give the other fingers room to descend into the slot, easing in on approach.
        palmPoint.addScaledVector(localTowardPlayer, 0.012 * contact ** 2 * (3 - 2 * contact));
      }
      armRoot.copy(palmPoint).addScaledVector(elbowDirection, forearmLength);
      armRotation.setFromUnitVectors(forearmAxis, elbowDirection.negate()).multiply(forearm.rotation);
      // The GLB armature object is in the editor's axis-aligned hand coordinates.
      forearm.bone.position.copy(armRoot);
      forearm.bone.quaternion.copy(armRotation);
      place(palm, palmPoint, palmRotation, armRoot, armRotation);
      for (const digit of digits) poseDigit(digit, frame, blackThumbChord);
    },
  };
}
