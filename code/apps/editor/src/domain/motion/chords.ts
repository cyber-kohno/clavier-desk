import { fingers, pointsForPose, restPose, solveFinger, specs, spreadLimits } from './fingers.ts';
import type { Hand, Finger, Vec3, JointPose } from './fingers.ts';
import { keys, contactRange, clearsBlackKeys } from './keyboard.ts';
export type Contact = {finger:Finger; midiNote:number; target:Vec3; preparationHeight?:number};
export type ChordPlan = {position:Vec3; contacts:Contact[]; hoverHeight?:number; idleJoints?:Partial<Record<Finger,JointPose>>};
export const WHITE_CONTACT_BACK=0.008,WHITE_CONTACT_FRONT=0.05;
const CHORD_CACHE_LIMIT=512;
const chordCache=new Map<string,ChordPlan>();
export function chordPoses(plan:ChordPlan,hand:Hand,lift:number):JointPose[]|undefined {
  const poses=plan.contacts.map(c=>solveFinger(hand,c.finger,c.target.map((v,i)=>v-plan.position[i]+(i===1?(lift>0&&plan.hoverHeight?lift*(c.preparationHeight??plan.hoverHeight)/plan.hoverHeight:lift):0)) as Vec3));
  if(poses.some(p=>!p))return;
  return poses as JointPose[];
}
export function planChord(hand:Hand,contacts:Contact[],hover:number,travel:number):ChordPlan {
  // Contact order is part of the key because callers match poses to notes by index.
  const key=JSON.stringify([hand,hover,travel,contacts]);
  const cached=chordCache.get(key);
  if(cached)return structuredClone(cached);

  const plan=findChordPlan(hand,contacts,hover,travel);
  if(chordCache.size>=CHORD_CACHE_LIMIT) {
    const oldest=chordCache.keys().next();
    if(!oldest.done)chordCache.delete(oldest.value);
  }
  // Plans are mutable and exposed through hand frames. Keep a private copy.
  chordCache.set(key,structuredClone(plan));
  return plan;
}

// Search shared palm placements, checking samples along the press path.
// This is a bounded prototype model, not a claim about a human player's reach.
function findChordPlan(hand:Hand,contacts:Contact[],hover:number,travel:number):ChordPlan {
  const low=Math.min(...contacts.map(c=>c.target[0]));
  const high=Math.max(...contacts.map(c=>c.target[0]));
  const wide=high-low>=0.14;
  const hasBlackKey=contacts.some(c=>keys.find(k=>k.midiNote===c.midiNote)?.black);
  const centered=searchChord(hand,contacts,hover,travel,wide);
  if(centered)return centered;

  if(wide) {
    // On a wide chord the outer fingers can touch the inner sides of their keys.
    // Leave a margin from the key edges and check the complete stroke there.
    const midpoint=(low+high)/2;
    const inset=contacts.map(contact=>{
      const key=keys.find(key=>key.midiNote===contact.midiNote)!;
      const reach=Math.max(0,key.width/2-0.003);
      const [x,y,z]=key.target;
      const offset=Math.max(-reach,Math.min(reach,midpoint-x));
      return {...contact,target:[x+offset,y,z] as Vec3};
    });
    const opened=searchChord(hand,inset,hover,travel,true);
    if(opened)return opened;
    // On narrow black keys the valid palm positions can fall between columns
    // of the regular 5 mm grid, even after moving the contacts inward.
    if(hasBlackKey) {
      const betweenColumns=searchChord(hand,inset,hover,travel,true,0.0025);
      if(betweenColumns)return betweenColumns;
    }
  }
  throw new Error(`These ${contacts.length} notes cannot be reached together within this model's spread and joint limits${hasBlackKey?' and black-key clearance':''}.`);
}

function searchChord(hand:Hand,contacts:Contact[],hover:number,travel:number,checkClearance=false,xOffset=0):ChordPlan|undefined {
  // Canonical order makes the search independent of JSON note order. Keep the
  // caller's contact order in the returned plan for note/target correspondence.
  const ordered=[...contacts].sort((a,b)=>a.finger-b.finger);
  // Reject disjoint palm positions using the fully extended fingers as an
  // outer bound. The stroke search still checks depth, curl and clearance.
  const handSign=hand==='right'?1:-1;
  let minPalm=-Infinity,maxPalm=Infinity;
  for(const {finger,target} of ordered) {
    const spec=specs[finger], [minSpread,maxSpread]=spreadLimits(finger);
    const length=spec.lengths[0]+spec.lengths[1];
    const minTip=spec.x-Math.max(0,Math.sin(spec.spread+maxSpread))*length;
    const maxTip=spec.x-Math.min(0,Math.sin(spec.spread+minSpread))*length;
    minPalm=Math.max(minPalm,handSign*target[0]-maxTip);
    maxPalm=Math.min(maxPalm,handSign*target[0]-minTip);
  }
  if(minPalm>maxPalm+1e-9)return;
  const rest=ordered.map(c=>pointsForPose(hand,c.finger,restPose(c.finger)));
  const surfaces=ordered.map(c=>keys.find(k=>k.midiNote===c.midiNote)!);
  const mixed=surfaces.some(k=>k.black),pressed=new Set(ordered.map(c=>c.midiNote));
  const checkKeys=mixed||checkClearance;
  const mirror=mixed&&hand==='left'?-1:1;
  const centerX=ordered.reduce((sum,c,i)=>sum+c.target[0]-rest[i][0][0],0)/ordered.length;
  let best:ChordPlan|undefined, bestScore=Infinity;
  // Keep the earlier contact choice when it works. For denser chords, fingers
  // need independently chosen depths instead of their unbent tip projection.
  // Preserve the original high preparation when feasible. Otherwise each
  // contact gets its own positive lift, while its full press stroke is checked.
  for(const adaptive of [false,true]) {
  if(best)break;
  for(const flexible of mixed?[true]:[false,true]) {
    if(best)break;
    // Mixed configurations search a coarse grid first, then refine locally.
    // If coarse sampling finds no solution, retain the full fine-grid search.
    for(const spacing of mixed?[2,1]:[1]) {
      const focus:ChordPlan|undefined=mixed&&spacing===1?best:undefined;
      const fx=focus?Math.round(((focus.position[0]-centerX)*mirror-xOffset)/0.005):0;
      const fz=focus?Math.round(focus.position[2]/0.005):0;
      const fy=focus?Math.round(focus.position[1]/0.005):0;
      for(let ix=focus?Math.max(-8,fx-1):-8;ix<=(focus?Math.min(8,fx+1):8);ix+=spacing)
      for(let iz=focus?Math.max(-14,fz-1):mixed?-14:0;iz<=(focus?Math.min(18,fz+1):18);iz+=spacing)
      for(let iy=focus?Math.max(-6,fy-1):-6;iy<=(focus?Math.min(4,fy+1):4);iy++) {
        const position:Vec3=[centerX+(ix*0.005+xOffset)*mirror,iy*0.005,iz*0.005];
        const idleJoints:Partial<Record<Finger,JointPose>>={};
        let idleClear=true;
        if(checkKeys)for(const finger of fingers.filter(f=>!ordered.some(c=>c.finger===f))) {
          const idle=[restPose(finger),{...restPose(finger),proximal:-0.65,distal:0.35}].find(pose=>clearsBlackKeys(
            pointsForPose(hand,finger,pose).map(p=>p.map((v,i)=>v+position[i]) as Vec3),pressed,0));
          if(!idle){idleClear=false;break;}
          idleJoints[finger]=idle;
        }
        if(!idleClear)continue;
        // Mixed chords also allow rear white contacts and move the palm backward.
        // Key tops and contact ranges come from the displayed keyboard geometry.
        const adjusted:Contact[]=[];
        for(const [index,contact] of ordered.entries()) {
          const [back,front]=mixed?contactRange(surfaces[index],true):[WHITE_CONTACT_BACK,WHITE_CONTACT_FRONT];
          const preferred=Math.max(back,Math.min(front,position[2]+rest[index][2][2]));
          const depths=flexible?Array.from({length:Math.round((front-back)*1000)+1},(_,i)=>back+i*0.001):[preferred];
          const neutral=restPose(contact.finger);
          const clearAt=(pose:JointPose,height:number)=>clearsBlackKeys(
            pointsForPose(hand,contact.finger,pose).map(p=>p.map((v,i)=>v+position[i]) as Vec3),pressed,Math.max(0,-height));
          let chosen:Contact|undefined,chosenScore=Infinity;
          for(const z of depths) for(const preparationHeight of adaptive?[...new Set([hover,Math.min(hover,0.012),Math.min(hover,0.006),Math.min(hover,0.003),Math.min(hover,0.001)])]:[hover]) {
            const local:Vec3=[contact.target[0]-position[0],contact.target[1]-position[1]+preparationHeight,z-position[2]];
            const top=solveFinger(hand,contact.finger,local);
            if(!top)continue;
            const score=(top.spread-neutral.spread)**2+(top.proximal+0.15)**2+(top.distal+0.1)**2+(hover-preparationHeight)*100;
            // Only a candidate that improves the score can replace the current contact.
            if(score>=chosenScore-(mixed?1e-10:0))continue;
            const bottom=solveFinger(hand,contact.finger,[local[0],local[1]-preparationHeight-travel,local[2]]);
            if(!bottom||checkKeys&&(!clearAt(top,preparationHeight)||!clearAt(bottom,-travel)))continue;
            let feasible=true;
            const samples=flexible?32:16;
            for(let i=1;i<samples;i++) {
              const height=preparationHeight-(preparationHeight+travel)*i/samples;
              const pose=solveFinger(hand,contact.finger,[local[0],local[1]-(preparationHeight+travel)*i/samples,local[2]]);
              if(!pose||checkKeys&&!clearAt(pose,height)){feasible=false;break;}
            }
            if(feasible){chosen={...contact,preparationHeight,target:[contact.target[0],contact.target[1],z]};chosenScore=score;}
          }
          if(!chosen)break;
          adjusted.push(chosen);
        }
        if(adjusted.length!==ordered.length)continue;
        const plan:ChordPlan={position,contacts:adjusted,hoverHeight:hover,...(checkKeys?{idleJoints}:{})};
        const hoverPoses=chordPoses(plan,hand,hover);
        if(!hoverPoses)continue;
        const score=hoverPoses.reduce((sum,p,i)=>sum+(p.spread-restPose(ordered[i].finger).spread)**2+(p.proximal+0.15)**2+(p.distal+0.1)**2,0);
        if(score<bestScore-(mixed?1e-10:0)){best=plan;bestScore=score;}
      }
    }
  }
  }
  if(!best)return;
  return {...best,contacts:contacts.map(c=>best!.contacts.find(p=>p.finger===c.finger)!)};
}
