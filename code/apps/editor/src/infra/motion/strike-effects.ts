import * as THREE from 'three';
import { keys } from '../../domain/motion/keyboard.ts';
import { NOTE_PLANE_Y, NOTE_STRIKE_Z, type createNoteStream, type StreamNote } from './note-stream.ts';

const BURST_COUNT = 11;
const BURST_LIFETIME = 0.54;
const TRAIL_INTERVAL = 0.064;
const TRAIL_LIFETIME = 0.585;
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
  const angles = new THREE.BufferAttribute(new Float32Array(CAPACITY), 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positions);
  geometry.setAttribute('tint', tints);
  geometry.setAttribute('diameter', sizes);
  geometry.setAttribute('opacity', opacities);
  geometry.setAttribute('sparkle', sparkles);
  geometry.setAttribute('angle', angles);
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
      attribute float angle;
      uniform float projectionScale;
      uniform float pixelRatio;
      varying vec3 vTint;
      varying float vOpacity;
      varying float vSparkle;
      varying float vAngle;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        float projectedSize = diameter * projectionScale / max(0.001, -viewPosition.z);
        gl_PointSize = clamp(projectedSize, mix(7.0, 2.0, sparkle) * pixelRatio, 54.0 * pixelRatio);
        vTint = tint;
        vOpacity = opacity;
        vSparkle = sparkle;
        vAngle = angle;
      }
    `,
    fragmentShader: `
      varying vec3 vTint;
      varying float vOpacity;
      varying float vSparkle;
      varying float vAngle;
      float puff(vec2 p) {
        return 1.0 - smoothstep(0.0, 1.0, length(p));
      }
      void main() {
        vec2 point = gl_PointCoord * 2.0 - 1.0;
        float c = cos(vAngle), s = sin(vAngle);
        vec2 p = mat2(c, -s, s, c) * point;
        float fade = 1.0 - smoothstep(0.63, 1.0, length(point));
        float cloud = puff((p + vec2(0.28, -0.09)) * vec2(1.58, 2.35))
                    + 0.78 * puff((p - vec2(0.28, -0.12)) * vec2(1.78, 2.08))
                    + 0.52 * puff((p - vec2(0.08, 0.26)) * vec2(2.4, 2.8));
        float texture = 0.70 + 0.30 * sin(p.x * 17.0 + sin(p.y * 11.0 + vAngle)) * cos(p.y * 13.0);
        vec2 q = abs(p);
        float rays = max(puff(vec2(q.x * 1.25, q.y * 7.5)), puff(vec2(q.x * 7.0, q.y * 1.55)));
        float core = 1.0 - smoothstep(0.02, 0.38, q.x + q.y);
        vec3 tint = mix(vTint, vec3(1.0), vSparkle * (0.35 + 0.57 * core));
        float shape = mix(0.68 * cloud * texture, max(core, rays), vSparkle);
        gl_FragColor = vec4(tint, vOpacity * fade * shape);
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
  function add(note: StreamNote, x: number, y: number, z: number, diameter: number, opacity: number, sparkle: boolean, angle: number) {
    const { r, g, b } = colors[note.hand];
    positions.setXYZ(count, note.x + x, NOTE_PLANE_Y + y, NOTE_STRIKE_Z + z);
    tints.setXYZ(count, r, g, b);
    sizes.setX(count, diameter);
    opacities.setX(count, opacity);
    sparkles.setX(count, sparkle ? 1 : 0);
    angles.setX(count, angle);
    count++;
  }

  function drift(note: StreamNote, seed: number, index: number, rise: number, sparkle: boolean, spread: number) {
    const lateral = 2 * variation(seed, index * 5) - 1;
    const speed = variation(seed, index * 5 + 1);
    const phase = variation(seed, index * 5 + 2) * Math.PI * 2;
    const scale = variation(seed, index * 5 + 3);
    const x = lateral * (0.28 * note.width + spread * rise)
      + 0.006 * rise * Math.sin(phase + rise * 5);
    // Keep slower particles close to the strike line and give the fastest more reach.
    const y = 0.010 + rise * (0.024 + speed ** 2 * 0.073);
    const z = -rise * (0.030 + speed ** 2 * 0.078);
    const size = sparkle ? 0.004 + scale * 0.015 : (0.026 + scale * 0.032) * (0.70 + 0.65 * rise);
    const brightness = sparkle ? 0.70 + 0.30 * Math.sin(phase + 17 * rise) ** 2 : 0.56;
    add(note, x, y, z, size, brightness * (1 - rise) ** 1.4, sparkle, phase + rise * 0.7);
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
          add(note, 0, 0.006, 0, note.width * 2.45, (0.42 + 0.42 * flash) * (1 - release / GLOW_RELEASE), false, seed);
        }
        if (age < BURST_LIFETIME) {
          const rise = age / BURST_LIFETIME;
          for (let index = 0; index < BURST_COUNT; index++) {
            drift(note, seed, index, rise, index % 2 === 0, 0.035);
          }
        }
        const first = Math.max(1, Math.ceil((age - TRAIL_LIFETIME) / TRAIL_INTERVAL));
        const last = Math.floor((Math.min(time, note.pressEnd) - note.start) / TRAIL_INTERVAL);
        for (let index = first; index <= last; index++) {
          const born = note.start + index * TRAIL_INTERVAL;
          const rise = (time - born) / TRAIL_LIFETIME;
          if (born >= note.pressEnd || rise < 0 || rise >= 1) continue;
          drift(note, seed, index + BURST_COUNT, rise, index % 3 === 0, 0.028);
        }
      }
      geometry.setDrawRange(0, count);
      points.visible = count > 0;
      if (count) positions.needsUpdate = tints.needsUpdate = sizes.needsUpdate = opacities.needsUpdate = sparkles.needsUpdate = angles.needsUpdate = true;
    },
  };
}
