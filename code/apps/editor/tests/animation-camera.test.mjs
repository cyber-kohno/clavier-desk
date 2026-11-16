import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createKeyboardCamera } from '../src/infra/motion/keyboard-camera.ts';
import { createAnimationCameraKeyboard } from '../src/state/animation-camera-keyboard.ts';
import { fitCamera } from '../src/infra/motion/framing.ts';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const input = (values = {}) => ({ horizontal: 0, vertical: 0, rotate: false, zoom: 0, ...values });
function fixture() {
  const camera = new PerspectiveCamera(40, 2, 0.001, 10);
  camera.position.set(0, 1, 2);
  const controls = new OrbitControls(camera);
  controls.minDistance = 0.08; controls.maxDistance = 8; controls.enableDamping = true;
  controls.update();
  return { camera, controls, move: createKeyboardCamera(camera, controls) };
}

test('screen-space pan preserves the viewing angle and camera-to-target offset', () => {
  const { camera, controls, move } = fixture();
  const offset = camera.position.clone().sub(controls.target), orientation = camera.quaternion.clone();
  const target = controls.target.clone();
  move(input({ horizontal: 1, vertical: 1 }), 1 / 60);
  assert.ok(controls.target.distanceTo(target) > 0);
  near(camera.position.clone().sub(controls.target).distanceTo(offset), 0);
  assert.ok(camera.quaternion.angleTo(orientation) < 1e-7);
  assert.equal(controls.enableDamping, true);
});

test('rotation preserves the target and orbit radius, including top-view presets and polar limits', () => {
  const { camera, controls, move } = fixture();
  const bounds = new Box3(new Vector3(-1, 0, -0.2), new Vector3(1, 0.2, 0.2));
  controls.target.copy(fitCamera(camera, bounds, true)); controls.update();
  const target = controls.target.clone(), radius = camera.position.distanceTo(target), before = camera.position.clone();
  move(input({ horizontal: 1, vertical: -1, rotate: true }), 1 / 60);
  near(controls.target.distanceTo(target), 0); near(camera.position.distanceTo(target), radius);
  assert.ok(camera.position.distanceTo(before) > 0);
  for (let i = 0; i < 200; i++) move(input({ vertical: 1, rotate: true }), 0.05);
  assert.ok(camera.position.toArray().every(Number.isFinite));
  assert.ok(controls.getPolarAngle() >= 0.001 - 1e-8);
});

test('preset changes keep world-up stable so horizontal orbit changes the viewing direction without roll', () => {
  const { camera, controls, move } = fixture();
  const bounds = new Box3(new Vector3(-0.8, -0.15, -0.84), new Vector3(0.8, 0.17, 0.5));
  const checkHorizontalOrbit = () => {
    const target = controls.target.clone(), before = camera.position.clone(), height = camera.position.y;
    for (let index = 0; index < 30; index++) move(input({ horizontal: 1, rotate: true }), 1 / 30);
    assert.ok(camera.position.distanceTo(before) > 0.1);
    near(camera.position.y, height);
    near(controls.target.distanceTo(target), 0);
    camera.updateMatrixWorld();
    near(new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).y, 0);
    assert.deepEqual(camera.up.toArray(), [0, 1, 0]);
  };
  controls.target.copy(fitCamera(camera, bounds, false)); controls.update();
  checkHorizontalOrbit();
  controls.target.copy(fitCamera(camera, bounds, true)); controls.update();
  // Lower the top camera to an oblique/side angle, then orbit horizontally.
  for (let index = 0; index < 25; index++) move(input({ vertical: -1, rotate: true }), 0.05);
  checkHorizontalOrbit();
  controls.target.copy(fitCamera(camera, bounds, false)); controls.update();
  checkHorizontalOrbit();
});

test('zoom approaches the target without passing through it and respects both distance limits', () => {
  const { camera, controls, move } = fixture(), target = controls.target.clone();
  const before = camera.position.distanceTo(target);
  move(input({ zoom: 1 }), 1 / 60);
  assert.ok(camera.position.distanceTo(target) < before);
  for (let i = 0; i < 200; i++) move(input({ zoom: 1 }), 0.05);
  near(camera.position.distanceTo(target), controls.minDistance);
  for (let i = 0; i < 200; i++) move(input({ zoom: -1 }), 0.05);
  near(camera.position.distanceTo(target), controls.maxDistance);
  near(controls.target.distanceTo(target), 0);
});

test('held movement is frame-rate independent and diagonal pan has the same speed as axial pan', () => {
  const slow = fixture(), fast = fixture(), diagonal = fixture();
  for (let i = 0; i < 30; i++) slow.move(input({ horizontal: 1 }), 1 / 30);
  for (let i = 0; i < 120; i++) fast.move(input({ horizontal: 1 }), 1 / 120);
  for (let i = 0; i < 30; i++) diagonal.move(input({ horizontal: 1, vertical: 1 }), 1 / 30);
  near(slow.camera.position.distanceTo(fast.camera.position), 0);
  near(slow.controls.target.length(), diagonal.controls.target.length());
  const stopped = slow.camera.position.clone(); slow.move(input(), 1 / 30);
  near(slow.camera.position.distanceTo(stopped), 0);
});

test('physical key tracking handles Shift changes, repeated events, numpad zoom and focus-loss reset', () => {
  const keys = createAnimationCameraKeyboard();
  const event = (key, code, shiftKey = false) => ({ key, code, shiftKey });
  keys.press(event('ArrowRight', 'ArrowRight'));
  keys.press(event('ArrowRight', 'ArrowRight'));
  assert.equal(keys.input().horizontal, 1);
  keys.press(event('Shift', 'ShiftLeft', true)); assert.equal(keys.input().rotate, true);
  keys.release(event('Shift', 'ShiftLeft')); assert.equal(keys.input().rotate, false);
  keys.press(event('+', 'NumpadAdd')); assert.equal(keys.input().zoom, 1);
  keys.release(event('+', 'NumpadAdd')); assert.equal(keys.input().zoom, 0);
  keys.press(event('+', 'Equal', true));
  keys.release(event('=', 'Equal')); assert.equal(keys.input().zoom, 0);
  keys.reset(); assert.deepEqual(keys.input(), input());
  assert.equal(keys.press(event('a', 'KeyA')), false);
});
