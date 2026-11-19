import * as THREE from 'three';
import { keys, KEYBOARD_WIDTH } from '../../domain/motion/keyboard.ts';
import type { AnimationPerformance } from '../../domain/performance/animation-performance.ts';
import { createNoteStream, NOTE_FAR_Z, NOTE_PLANE_Y, NOTE_STRIKE_Z } from './note-stream.ts';
import { createStrikeEffects } from './strike-effects.ts';

/** One opaque instanced draw for visible bars, shared by the main 3D camera. */
export function createFallingNotes(scene: THREE.Scene) {
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const depth = NOTE_STRIKE_Z - NOTE_FAR_Z;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(KEYBOARD_WIDTH + 0.025, 0.003, depth),
    new THREE.MeshBasicMaterial({ color: '#142330' }));
  floor.position.set(0, NOTE_PLANE_Y - 0.008, (NOTE_STRIKE_Z + NOTE_FAR_Z) / 2); group.add(floor);
  const lanes = keys.flatMap(key => [key.target[0], NOTE_PLANE_Y - 0.005, NOTE_STRIKE_Z,
    key.target[0], NOTE_PLANE_Y - 0.005, NOTE_FAR_Z]);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(lanes, 3));
  group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#263a49' })));
  const strike = new THREE.Mesh(new THREE.BoxGeometry(KEYBOARD_WIDTH + 0.025, 0.004, 0.004),
    new THREE.MeshBasicMaterial({ color: '#c5e6e4' }));
  strike.position.set(0, NOTE_PLANE_Y, NOTE_STRIKE_Z); group.add(strike);
  const barGeometry = new THREE.BoxGeometry(1, 1, 1), material = new THREE.MeshBasicMaterial({ color: 'white' });
  let capacity = 128;
  function makePool() {
    const mesh = new THREE.InstancedMesh(barGeometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.count = 0;
    group.add(mesh); return mesh;
  }
  let pool = makePool();
  const transform = new THREE.Object3D();
  const colors = { left: new THREE.Color('#70bdf2'), right: new THREE.Color('#ffad66'),
    leftActive: new THREE.Color('#c6ecff'), rightActive: new THREE.Color('#ffe4bc') };
  const strikes = createStrikeEffects(group, colors);
  let source: AnimationPerformance | undefined, stream: ReturnType<typeof createNoteStream> | undefined;
  let lastTime = NaN;
  return {
    update(performance: AnimationPerformance | undefined, time: number, visible: boolean) {
      group.visible = visible && performance !== undefined;
      if (!group.visible) return;
      if (source === performance && lastTime === time) return;
      if (source !== performance) { source = performance; stream = createNoteStream(performance!.playback); }
      lastTime = time;
      const frames = stream!.framesAt(time);
      if (frames.length > capacity) {
        group.remove(pool); pool.dispose();
        capacity = 2 ** Math.ceil(Math.log2(frames.length)); pool = makePool();
      }
      pool.count = frames.length;
      frames.forEach((bar, index) => {
        transform.position.set(bar.note.x, NOTE_PLANE_Y, (bar.front + bar.back) / 2);
        transform.scale.set(bar.note.width, 0.006, bar.front - bar.back); transform.updateMatrix();
        pool.setMatrixAt(index, transform.matrix);
        pool.setColorAt(index, bar.active ? colors[bar.note.hand === 'left' ? 'leftActive' : 'rightActive'] : colors[bar.note.hand]);
      });
      pool.instanceMatrix.needsUpdate = true;
      if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
      strikes.update(stream!, time);
    },
  };
}
