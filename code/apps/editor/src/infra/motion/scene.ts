import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { keys, KEYBOARD_WIDTH, TRAVEL, evaluate, keyDepth } from '../../domain/motion/motion.ts';
import type { Note } from '../../domain/motion/motion.ts';
import { fingers, pointsForPose, restPose } from '../../domain/motion/fingers.ts';
import type { Hand } from '../../domain/motion/fingers.ts';
import { fitCamera } from './framing.ts';
import { createKeyboardCamera } from './keyboard-camera.ts';
import { createFallingNotes, noteColors } from './falling-notes.ts';
import { NOTE_FAR_Z } from './note-stream.ts';
import type { AnimationPerformance } from '../../domain/performance/animation-performance.ts';
import { WRIST, forearmEndpoints, FULL_VIEW_MIN, FULL_VIEW_MAX } from '../../domain/motion/movement.ts';
import type { MotionStyle } from '../../domain/motion/movement.ts';
import type { IdleFingerStyle, StrikeStyle } from '../../domain/motion/scale-motion.ts';
import { createPianoHands, disposePianoHandModels } from './piano-hand.ts';
import handModelUrl from './assets/piano-hand-right.glb?url';

function createKeyReflection(renderer: THREE.WebGLRenderer) {
  // Render a soft overhead light into a reflection map used only by the keys.
  const studio = new THREE.Scene();
  studio.background = new THREE.Color('#20262e');
  const geometry = new THREE.PlaneGeometry(2.8, 0.8);
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.8, 2.7, 2.5) });
  const panel = new THREE.Mesh(geometry, material);
  panel.rotation.x = Math.PI / 2;
  panel.position.set(-0.25, 0.8, -0.45);
  studio.add(panel);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const reflection = pmrem.fromScene(studio, 0.12, 0.1, 5, { size: 64 });
  pmrem.dispose();
  geometry.dispose();
  material.dispose();
  return reflection;
}

function addKeyEdgeLighting(material: THREE.MeshPhysicalMaterial, width: number) {
  const left = { value: new THREE.Color(0, 0, 0) };
  const right = { value: new THREE.Color(0, 0, 0) };
  material.onBeforeCompile = shader => {
    shader.uniforms.keyEdgeLeft = left;
    shader.uniforms.keyEdgeRight = right;
    shader.uniforms.keyHalfWidth = { value: width / 2 };
    shader.vertexShader = `
      uniform float keyHalfWidth;
      varying float keyAcross;
    ` + shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      keyAcross = position.x / keyHalfWidth;
    `);
    shader.fragmentShader = `
      uniform vec3 keyEdgeLeft;
      uniform vec3 keyEdgeRight;
      varying float keyAcross;
    ` + shader.fragmentShader.replace('#include <emissivemap_fragment>', `
      #include <emissivemap_fragment>
      totalEmissiveRadiance += keyEdgeLeft * smoothstep(0.46, 1.0, -keyAcross)
                            + keyEdgeRight * smoothstep(0.46, 1.0, keyAcross);
    `);
  };
  return { left: left.value, right: right.value };
}

export function createScene(container: HTMLElement) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101a25');
  const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 10);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.minDistance = 0.08;
  controls.maxDistance = 8;
  const moveCamera = createKeyboardCamera(camera, controls);
  const fallingNotes = createFallingNotes(scene);
  scene.add(new THREE.HemisphereLight(0xe5f4ff, 0x526175, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(-0.2, 0.6, 0.3);
  scene.add(light);
  function box(w:number,h:number,d:number,color:string) {
    return new THREE.Mesh(new THREE.BoxGeometry(w,h,d), new THREE.MeshStandardMaterial({color, roughness:0.55}));
  }
  const base = box(KEYBOARD_WIDTH+0.025,0.025,0.18,'#26394b');
  base.position.set(0,-0.03,-0.02); scene.add(base);
  const keyReflection = createKeyReflection(renderer);
  const leftGlow = new THREE.Color(noteColors.left);
  const rightGlow = new THREE.Color(noteColors.right);
  const whiteKeyColor = new THREE.Color('#89867f');
  const blackKeyColor = new THREE.Color('#111114');
  const keyMeshes = keys.map((k, index) => {
    const geometry = new RoundedBoxGeometry(k.width, k.height, k.length, 2, k.black ? 0.0011 : 0.00065);
    const material = new THREE.MeshPhysicalMaterial({
      color: k.black ? blackKeyColor : whiteKeyColor,
      roughness: k.black ? 0.36 : 0.30,
      clearcoat: k.black ? 0.30 : 0.45,
      clearcoatRoughness: 0.25,
      envMap: keyReflection.texture,
      envMapIntensity: 0.40,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(k.target[0],k.target[1]-k.height/2,k.z);
    scene.add(mesh);
    const edges = addKeyEdgeLighting(material, k.width);
    const neighbors = keys.flatMap((other, otherIndex) => {
      if (otherIndex === index) return [];
      const offset = other.target[0] - k.target[0];
      const distance = Math.abs(offset);
      if (distance > 0.024) return [];
      return [{ index: otherIndex, weight: 0.14 * (1 - distance / 0.04),
        edge: offset < 0 ? edges.left : edges.right }];
    });
    return { mesh, restY: mesh.position.y, key: k, edges, neighbors, left: 0, right: 0 };
  });
  const colors = ['#ffbd70','#63dfcf','#7faaff','#c5a0ff','#ff8ca5'];
  function makeHand(side:Hand) {
    const group=new THREE.Group(); scene.add(group);
    const legacyHand=new THREE.Group(); group.add(legacyHand);
    const palm=box(0.09,0.022,0.055,side==='left'?'#8eb0ca':'#bd937c');
    palm.position.set(0,0.028,0.075);legacyHand.add(palm);
    const digits=fingers.map((finger,i)=>{
      const segments=[box(finger===1?0.018:0.012,0.012,1,side==='left'?'#adcce0':'#d4ab92'),box(finger===1?0.017:0.011,0.011,1,side==='left'?'#adcce0':'#d4ab92')];
      segments.forEach(mesh=>legacyHand.add(mesh));
      const joints=[0,1].map(()=>{
        const joint=new THREE.Mesh(new THREE.SphereGeometry(0.007,12,8),new THREE.MeshStandardMaterial({color:side==='left'?'#7393ae':'#aa8169'}));
        legacyHand.add(joint);return joint;
      });
      const marker=new THREE.Mesh(new THREE.SphereGeometry(0.003,12,8),new THREE.MeshBasicMaterial({color:colors[i],depthTest:false}));
      marker.renderOrder=10;group.add(marker);
      return {finger,segments,joints,marker};
    });
    const targets=fingers.map(()=>{
      const target=new THREE.Mesh(new THREE.SphereGeometry(0.004,16,10),new THREE.MeshBasicMaterial({color:'#ffdc7b',wireframe:true,depthTest:false}));
      target.renderOrder=11;scene.add(target);return target;
    });
    const arm=new THREE.Group();scene.add(arm);
    const material=new THREE.MeshStandardMaterial({color:side==='left'?'#789bb8':'#b78e76',roughness:0.65});
    const forearm=new THREE.Mesh(new THREE.CylinderGeometry(0.026,0.016,1,16),material);
    const elbow=new THREE.Mesh(new THREE.SphereGeometry(0.026,16,12),material);
    const wrist=new THREE.Mesh(new THREE.SphereGeometry(0.016,16,12),material);
    arm.add(forearm,elbow,wrist);
    return {side,group,legacyHand,digits,targets,arm,forearm,elbow,wrist};
  }
  const hands=[makeHand('left'),makeHand('right')];
  let rigs: ReturnType<typeof createPianoHands> | undefined;
  let disposed = false;
  void new GLTFLoader().loadAsync(handModelUrl).then(({ scene: root }) => {
    if (disposed) { disposePianoHandModels(root); return; }
    const loaded = createPianoHands(root);
    for (const { side, group } of hands) group.add(loaded[side].root);
    rigs = loaded;
  }).catch(error => {
    if (!disposed) console.warn('Could not load the hand models:', error);
  });
  const segmentAxis=new THREE.Vector3(0,0,1);
  // Include raised hands and the full elbow-to-wrist guide at either end.
  const framingBounds = new THREE.Box3(
    new THREE.Vector3(...FULL_VIEW_MIN),
    new THREE.Vector3(...FULL_VIEW_MAX),
  );
  const noteBounds = framingBounds.clone();
  noteBounds.min.z = NOTE_FAR_Z - 0.03;
  let currentView: boolean | 'notes' = false;
  function view(mode: boolean | 'notes') {
    currentView = mode;
    // Clear residual OrbitControls damping before applying the preset.
    controls.enableDamping=false; controls.update();
    controls.target.copy(fitCamera(camera, mode === true ? framingBounds : noteBounds, mode !== false));
    controls.update(); controls.enableDamping=true;
  }
  view(false);
  const observer = new ResizeObserver(() => {
    const {width,height} = container.getBoundingClientRect();
    camera.aspect = width/Math.max(height,1); camera.updateProjectionMatrix();
    renderer.setSize(width,height);
    view(currentView);
  });
  observer.observe(container);
  return {
    view,
    moveCamera,
    draw(notes:Note[],time:number,debug:boolean,manualAngles?:Record<Hand,number[]>,style:MotionStyle='smooth',showForearms=true,idleStyle:IdleFingerStyle='connected',strikeStyle:StrikeStyle='smooth',wristMotion=false,performance?:AnimationPerformance,showNotes=true) {
      fallingNotes.update(performance, time, showNotes);
      const frame = evaluate(manualAngles?[]:notes,time,style,idleStyle,strikeStyle,wristMotion);
      hands.forEach(({side,group,legacyHand,digits,targets,arm,forearm,elbow,wrist})=>{
        const pose=frame[side];
        group.rotation.set(...pose.rotation);
        const pivot=new THREE.Vector3(...WRIST);
        const offset=pivot.clone().sub(pivot.clone().applyQuaternion(group.quaternion));
        group.position.fromArray(pose.position).add(offset);
        const endpoints=forearmEndpoints(pose.position,side,pose.forearmGuide);
        const wristPosition=new THREE.Vector3(...endpoints.wrist),elbowPosition=new THREE.Vector3(...endpoints.elbow);
        const direction=elbowPosition.clone().sub(wristPosition);
        const handRig = rigs?.[side];
        const useRig = handRig !== undefined && showForearms;
        if (handRig) handRig.root.visible = useRig;
        legacyHand.visible = !useRig;
        arm.visible=showForearms && !useRig;
        if (arm.visible) {
          wrist.position.copy(wristPosition);elbow.position.copy(elbowPosition);
          forearm.position.copy(wristPosition).add(elbowPosition).multiplyScalar(0.5);
          forearm.scale.y=direction.length();
          forearm.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize());
        }
        if(manualAngles)for(const finger of fingers)pose.joints[finger]=restPose(finger,manualAngles[side][finger-1]*Math.PI/180);
        if (useRig) handRig.pose(pose, direction, group.quaternion);
        digits.forEach(({finger,segments,joints,marker})=>{
          marker.visible=debug;
          if (useRig) {
            if (!debug) return;
            group.worldToLocal(handRig.contacts[finger].getWorldPosition(marker.position));
          } else {
            const points=pointsForPose(side,finger,pose.joints[finger]).map(p=>new THREE.Vector3(...p));
            segments.forEach((mesh,i)=>{
              const direction=points[i+1].clone().sub(points[i]);
              mesh.position.copy(points[i]).add(points[i+1]).multiplyScalar(0.5);
              mesh.scale.z=direction.length();mesh.quaternion.setFromUnitVectors(segmentAxis,direction.normalize());
              joints[i].position.copy(points[i]);
            });
            marker.position.copy(points[2]);
          }
          marker.scale.setScalar(pose.activeNotes.some(n=>n.finger===finger)?1.5:1);
        });
        targets.forEach((target,index)=>{
          const note=pose.activeNotes[index];target.visible=debug&&!!note;
          if(note){target.position.fromArray(pose.targets[index]);target.position.y-=(pose.depths?.[index]??pose.depth)*TRAVEL;}
        });
      });
      for (const state of keyMeshes) {
        state.left = keyDepth(frame.left, state.key.midiNote);
        state.right = keyDepth(frame.right, state.key.midiNote);
        state.mesh.position.y = state.restY - Math.max(state.left, state.right) * TRAVEL;
      }
      for (const { mesh, key, left, right, edges, neighbors } of keyMeshes) {
        const direct = Math.max(left, right);
        edges.left.setRGB(0, 0, 0);
        edges.right.setRGB(0, 0, 0);
        for (const { index, weight, edge } of neighbors) {
          const blue = keyMeshes[index].left * weight;
          const amber = keyMeshes[index].right * weight;
          edge.r = Math.max(edge.r, leftGlow.r * blue + rightGlow.r * amber);
          edge.g = Math.max(edge.g, leftGlow.g * blue + rightGlow.g * amber);
          edge.b = Math.max(edge.b, leftGlow.b * blue + rightGlow.b * amber);
        }
        // Sample the current key depth so seeking and releasing keys also update their light.
        const overlap = Math.max(1, left + right);
        const blue = 1.4 * left / overlap;
        const amber = 1.4 * right / overlap;
        mesh.material.color.copy(key.black ? blackKeyColor : whiteKeyColor).multiplyScalar(1 - 0.45 * direct);
        mesh.material.emissive.setRGB(
          leftGlow.r * blue + rightGlow.r * amber,
          leftGlow.g * blue + rightGlow.g * amber,
          leftGlow.b * blue + rightGlow.b * amber,
        );
      }
      controls.update(); renderer.render(scene,camera);

    },
    dispose() {
      disposed = true;
      rigs?.dispose();
      observer.disconnect(); controls.dispose();
      scene.traverse(object => {
        if (object instanceof THREE.InstancedMesh) object.dispose();
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Points) {
          object.geometry.dispose(); const materials=Array.isArray(object.material)?object.material:[object.material]; materials.forEach(m=>m.dispose());
        }
      });
      keyReflection.dispose();
      renderer.dispose(); renderer.domElement.remove();

    },
  };
}
