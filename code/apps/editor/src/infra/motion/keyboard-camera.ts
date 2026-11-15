import { MathUtils, PerspectiveCamera, Quaternion, Spherical, Vector3 } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraInput } from '../../state/animation-camera-keyboard.ts';

/** Public camera/OrbitControls state only; mouse and keyboard share one target. */
export function createKeyboardCamera(camera: PerspectiveCamera, controls: OrbitControls) {
  // OrbitControls captures its up axis at construction, before camera presets.
  const toOrbit = new Quaternion().setFromUnitVectors(camera.up.clone().normalize(), new Vector3(0, 1, 0));
  const fromOrbit = toOrbit.clone().invert();
  const offset = new Vector3(), translation = new Vector3(), right = new Vector3(), up = new Vector3();
  const spherical = new Spherical();
  return (input: CameraInput, elapsed: number) => {
    if (!Number.isFinite(elapsed) || elapsed <= 0 || (!input.horizontal && !input.vertical && !input.zoom)) return;
    const dt = Math.min(elapsed, 0.05);
    // Drain mouse damping before applying an exact keyboard pose. Keyboard
    // movement stops at keyup instead of leaving residual orbital motion.
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    offset.copy(camera.position).sub(controls.target);
    const diagonal = Math.max(1, Math.hypot(input.horizontal, input.vertical));
    const x = input.horizontal / diagonal, y = input.vertical / diagonal;
    if (input.rotate) {
      spherical.setFromVector3(offset.applyQuaternion(toOrbit));
      spherical.theta = MathUtils.clamp(spherical.theta + x * dt, controls.minAzimuthAngle, controls.maxAzimuthAngle);
      spherical.phi = MathUtils.clamp(spherical.phi - y * dt,
        Math.max(0.001, controls.minPolarAngle), Math.min(Math.PI - 0.001, controls.maxPolarAngle));
      offset.setFromSpherical(spherical).applyQuaternion(fromOrbit);
    } else {
      camera.updateMatrixWorld();
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      // Screen-space travel scales with visible height, so close-up and full
      // keyboard views remain equally controllable.
      const travel = 2 * offset.length() * Math.tan(MathUtils.degToRad(camera.fov / 2)) * dt * 0.45;
      translation.copy(right).multiplyScalar(x * travel).addScaledVector(up, y * travel);
      controls.target.add(translation);
    }
    if (input.zoom) {
      const distance = MathUtils.clamp(offset.length() * Math.exp(-input.zoom * dt * 1.2), controls.minDistance, controls.maxDistance);
      offset.setLength(distance);
    }
    camera.position.copy(controls.target).add(offset);
    controls.update();
    controls.enableDamping = damping;
  };
}
