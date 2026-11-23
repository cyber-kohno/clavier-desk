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

function createKeyGeometry(width: number, height: number, length: number, black: boolean, topY: number) {
  if (!black) return new RoundedBoxGeometry(width, height, length, 4, 0.0013);

  // The front is vertical below the resting white-key surface.
  const top = height / 2;
  const bottom = -top;
  const front = -length / 2;
  const back = length / 2;
  const whiteSurface = top - topY;
  const nose = front + 0.007;
  const noseRound = 0.0025;
  const profile = new THREE.Shape();
  // The profile's X axis becomes -Z after rotation.
  profile.moveTo(back, bottom);
  profile.lineTo(front, bottom);
  profile.lineTo(front, whiteSurface);
  // Round the transition from the front slope to the flat playing surface.
  profile.lineTo(nose - noseRound * (nose - front) / topY, top - noseRound);
  profile.quadraticCurveTo(nose, top, nose + noseRound, top);
  profile.lineTo(back, top);
  profile.closePath();

  const bevel = 0.0011;
  const geometry = new THREE.ExtrudeGeometry(profile, {
    depth: width - 2 * bevel,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 5,
    curveSegments: 8,
  });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(-width / 2 + bevel, 0, 0);
  // Preserve the base width and narrow the two sides towards the top.
  const positions = geometry.getAttribute('position');
  const topWidthRatio = 0.78;
  for (let i = 0; i < positions.count; i++) {
    const heightRatio = (positions.getY(i) - bottom) / height;
    positions.setX(i, positions.getX(i) * THREE.MathUtils.lerp(1, topWidthRatio, heightRatio));
  }
  geometry.computeVertexNormals();
  return geometry;
}

function addWhiteKeyWoodSides(material: THREE.MeshPhysicalMaterial, height: number, length: number) {
  material.onBeforeCompile = shader => {
    shader.uniforms.woodColor = { value: new THREE.Color('#ad8256') };
    shader.uniforms.capBottom = { value: height / 2 - 0.002 };
    shader.uniforms.woodEnd = { value: length / 2 - 0.002 };
    shader.vertexShader = 'varying vec3 keyLocalPosition;\nvarying float keySide;\n' +
      shader.vertexShader.replace('#include <begin_vertex>', `
        #include <begin_vertex>
        keyLocalPosition = position;
        keySide = abs(normal.x);
      `);
    shader.fragmentShader = `
      varying vec3 keyLocalPosition;
      varying float keySide;
      uniform vec3 woodColor;
      uniform float capBottom;
      uniform float woodEnd;
    ` + shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float side = smoothstep(0.55, 0.9, keySide);
      float belowCap = 1.0 - smoothstep(capBottom - 0.0004, capBottom, keyLocalPosition.y);
      float insideFront = 1.0 - smoothstep(woodEnd - 0.0004, woodEnd, keyLocalPosition.z);
      float grain = 0.94 + 0.06 * sin(keyLocalPosition.y * 5100.0 + sin(keyLocalPosition.z * 115.0));
      diffuseColor.rgb = mix(diffuseColor.rgb, woodColor * grain, side * belowCap * insideFront);
    `);
  };
}

export function createScene(container: HTMLElement) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#101a25');
  const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 10);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.minDistance = 0.08;
  controls.maxDistance = 8;
  const moveCamera = createKeyboardCamera(camera, controls);
  const fallingNotes = createFallingNotes(scene);
  scene.add(new THREE.HemisphereLight(0xe5f4ff, 0x526175, 1.4));
  const light = new THREE.DirectionalLight(0xfff4e5, 3);
  light.position.set(-0.16, 0.55, -0.34);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 1024);
  Object.assign(light.shadow.camera, {
    left: -0.72, right: 0.72, top: 0.32, bottom: -0.32, near: 0.1, far: 1.4,
  });
  light.shadow.camera.updateProjectionMatrix();
  light.shadow.normalBias = 0.0007;
  light.shadow.bias = -0.00015;
  light.shadow.radius = 2;
  scene.add(light);
  // A low front fill reveals the sloped faces that point away from the main light.
  const frontFill = new THREE.DirectionalLight(0xe8eef8, 0.85);
  frontFill.position.set(0, 0.17, 0.55);
  scene.add(frontFill);
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
  const ledZ = -0.091;
  const ledGeometry = new RoundedBoxGeometry(0.007, 0.002, 0.004, 2, 0.0008);
  const ledRail = box(KEYBOARD_WIDTH, 0.009, 0.008, '#171c23');
  ledRail.position.set(0, 0.01, ledZ);
  scene.add(ledRail);
  // Every key can glow. A fixed pool lights the surrounding keys and hands.
  const ledLights = Array.from({ length: 10 }, () => {
    const led = new THREE.PointLight(0xffffff, 0, 0.12, 2);
    scene.add(led);
    return led;
  });
  const keyMeshes = keys.map(k => {
    const geometry = createKeyGeometry(k.width, k.height, k.length, k.black, k.target[1]);
    const material = new THREE.MeshPhysicalMaterial({
      color: k.black ? blackKeyColor : whiteKeyColor,
      roughness: k.black ? 0.28 : 0.30,
      clearcoat: k.black ? 0.55 : 0.45,
      clearcoatRoughness: k.black ? 0.19 : 0.25,
      envMap: keyReflection.texture,
      envMapIntensity: k.black ? 0.55 : 0.40,
    });
    if (!k.black) addWhiteKeyWoodSides(material, k.height, k.length);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(k.target[0],k.target[1]-k.height/2,k.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    const led = new THREE.Mesh(ledGeometry, new THREE.MeshBasicMaterial());
    led.position.set(k.target[0], 0.015, ledZ);
    scene.add(led);
    return { mesh, restY: mesh.position.y, key: k, led, lightColor: new THREE.Color(), depth: 0 };
  });
  function enableHandShadows(root: THREE.Object3D) {
    root.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
  }
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
    enableHandShadows(legacyHand);
    enableHandShadows(arm);
    return {side,group,legacyHand,digits,targets,arm,forearm,elbow,wrist};
  }
  const hands=[makeHand('left'),makeHand('right')];
  let rigs: ReturnType<typeof createPianoHands> | undefined;
  let disposed = false;
  void new GLTFLoader().loadAsync(handModelUrl).then(({ scene: root }) => {
    if (disposed) { disposePianoHandModels(root); return; }
    const loaded = createPianoHands(root);
    for (const { side, group } of hands) {
      enableHandShadows(loaded[side].root);
      group.add(loaded[side].root);
    }
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
        const left = keyDepth(frame.left, state.key.midiNote);
        const right = keyDepth(frame.right, state.key.midiNote);
        state.depth = Math.max(left, right);
        state.mesh.position.y = state.restY - state.depth * TRAVEL;
        state.lightColor.copy(leftGlow).lerp(rightGlow, right / (left + right || 1));
        state.mesh.material.emissive.copy(state.lightColor).multiplyScalar(state.depth * 1.05);
        state.led.material.color.copy(state.lightColor).multiplyScalar(state.depth * 1.8);
        if (state.depth === 0) state.led.material.color.setHex(0x343941);
      }
      const pressed = keyMeshes.filter(key => key.depth > 0).sort((a, b) => b.depth - a.depth);
      for (const [index, light] of ledLights.entries()) {
        const state = pressed[index];
        light.intensity = state ? 0.075 * state.depth : 0;
        if (!state) continue;
        const surfaceY = state.key.target[1] - state.depth * TRAVEL;
        light.position.set(state.key.target[0], surfaceY + 0.028, state.key.target[2]);
        light.color.copy(state.lightColor);
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
          if (object.geometry !== ledGeometry) object.geometry.dispose();
          const materials=Array.isArray(object.material)?object.material:[object.material]; materials.forEach(m=>m.dispose());
        }
      });
      keyReflection.dispose();
      ledGeometry.dispose();
      light.shadow.dispose();
      renderer.dispose(); renderer.domElement.remove();

    },
  };
}
