import * as THREE from 'three';
import { keys } from '../../domain/motion/keyboard.ts';
import { NOTE_PLANE_Y, NOTE_STRIKE_Z, type createNoteStream, type StreamNote } from './note-stream.ts';

const BURST_COUNT = 4;
const BURST_LIFETIME = 0.29;
const TRAIL_INTERVAL = 0.072;
const TRAIL_LIFETIME = 0.39;
const GLOW_RELEASE = 0.17;
const EFFECT_TAIL = Math.max(BURST_LIFETIME, TRAIL_LIFETIME, GLOW_RELEASE);
const CAPACITY = keys.length * (1 + BURST_COUNT + Math.ceil(TRAIL_LIFETIME / TRAIL_INTERVAL));

function variation(seed: number, index: number) {
  const value = Math.sin(seed + index * 127.1) * 43758.5453;
  return value - Math.floor(value);
}

export function createStrikeEffects(group: THREE.Group, colors: Record<StreamNote['hand'], THREE.Color>) {
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const tints = new THREE.BufferAttribute(new Float32Array(CAPACITY * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const sizes = new THREE.BufferAttribute(new Float32Array(CAPACITY), 1).setUsage(THREE.DynamicDrawUsage);
  const opacities = new THREE.BufferAttribute(new Float32Array(CAPACITY), 1).setUsage(THREE.DynamicDrawUsage);
  const sparkles = new THREE.BufferAttribute(new Float32Array(CAPACITY), 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positions);
  geometry.setAttribute('tint', tints);
  geometry.setAttribute('diameter', sizes);
  geometry.setAttribute('opacity', opacities);
  geometry.setAttribute('sparkle', sparkles);
  geometry.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    uniforms: { projectionScale: { value: 1 }, pixelRatio: { value: 1 } },
    vertexShader: `
      attribute vec3 tint;
      attribute float diameter;
      attribute float opacity;
      attribute float sparkle;
      uniform float projectionScale;
      uniform float pixelRatio;
      varying vec3 vTint;
      varying float vOpacity;
      varying float vSparkle;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        float projectedSize = diameter * projectionScale / max(0.001, -viewPosition.z);
        gl_PointSize = clamp(projectedSize, mix(14.0, 8.0, sparkle) * pixelRatio, 44.0 * pixelRatio);
        vTint = tint;
        vOpacity = opacity;
        vSparkle = sparkle;
      }
    `,
    fragmentShader: `
      varying vec3 vTint;
      varying float vOpacity;
      varying float vSparkle;
      void main() {
        float radius = length(gl_PointCoord * 2.0 - 1.0);
        float falloff = 1.0 - smoothstep(0.0, 1.0, radius);
        float disc = 1.0 - smoothstep(0.42, 0.70, radius);
        float core = (1.0 - smoothstep(0.05, 0.43, radius)) * vSparkle;
        vec3 tint = mix(vTint, vec3(1.0), 0.80 * core);
        gl_FragColor = vec4(tint, vOpacity * mix(falloff * falloff, max(disc, falloff * 0.45), vSparkle));
        #include <colorspace_fragment>
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'Note strike effects';
  points.frustumCulled = false;
  const bufferSize = new THREE.Vector2();
  points.onBeforeRender = (renderer, _scene, camera) => {
    material.uniforms.projectionScale.value = renderer.getDrawingBufferSize(bufferSize).y * camera.projectionMatrix.elements[5] / 2;
    material.uniforms.pixelRatio.value = renderer.getPixelRatio();
  };
  group.add(points);

  const lanes = new Map<number, StreamNote>();
  let count = 0;
  function add(note: StreamNote, x: number, y: number, z: number, diameter: number, opacity: number, sparkle: boolean) {
    const { r, g, b } = colors[note.hand];
    positions.setXYZ(count, note.x + x, NOTE_PLANE_Y + y, NOTE_STRIKE_Z + z);
    tints.setXYZ(count, r, g, b);
    sizes.setX(count, diameter);
    opacities.setX(count, opacity);
    sparkles.setX(count, sparkle ? 1 : 0);
    count++;
  }

  return {
    update(stream: ReturnType<typeof createNoteStream>, time: number) {
      count = 0;
      lanes.clear();
      // A reattack takes over its lane. This also bounds the draw on dense scores.
      for (const note of stream.strikesAt(time, EFFECT_TAIL)) lanes.set(note.midi, note);
      for (const note of lanes.values()) {
        const age = time - note.start;
        const seed = note.midi * 13 + note.start * 97;
        const release = Math.max(0, time - note.pressEnd);
        if (release < GLOW_RELEASE) {
          const flash = Math.max(0, 1 - age / 0.13);
          add(note, 0, 0.006, 0, note.width * 2.05, (0.52 + 0.43 * flash) * (1 - release / GLOW_RELEASE), false);
        }
        if (age < BURST_LIFETIME) {
          const rise = age / BURST_LIFETIME;
          for (let index = 0; index < BURST_COUNT; index++) {
            const spread = variation(seed, index);
            const x = (spread - 0.5) * note.width * (0.28 + 0.42 * rise);
            add(note, x, 0.012 + rise * (0.032 + spread * 0.025), -0.028 * rise,
              note.width * (0.65 + spread * 0.24), 1 - rise * rise, true);
          }
        }
        const first = Math.max(1, Math.ceil((age - TRAIL_LIFETIME) / TRAIL_INTERVAL));
        const last = Math.floor((Math.min(time, note.pressEnd) - note.start) / TRAIL_INTERVAL);
        for (let index = first; index <= last; index++) {
          const born = note.start + index * TRAIL_INTERVAL;
          const rise = (time - born) / TRAIL_LIFETIME;
          if (born >= note.pressEnd || rise < 0 || rise >= 1) continue;
          const spread = variation(seed, index + BURST_COUNT);
          const x = (spread - 0.5) * note.width * 0.65;
          add(note, x, 0.012 + rise * (0.032 + spread * 0.021), -0.029 * rise,
            note.width * (0.48 + spread * 0.18), 0.90 * (1 - rise * rise), true);
        }
      }
      geometry.setDrawRange(0, count);
      points.visible = count > 0;
      if (count) positions.needsUpdate = tints.needsUpdate = sizes.needsUpdate = opacities.needsUpdate = sparkles.needsUpdate = true;
    },
  };
}
