import { fingers, pointsForPose, restPose, solveFinger } from './fingers.ts';
import type { Finger, Hand, JointPose, Vec3 } from './fingers.ts';
import { keys, contactRange, clearsBlackKeys } from './keyboard.ts';
import { ease } from './movement.ts';
import { fingerStroke } from './held-motion.ts';
import type { FingerEvent, HeldPlan } from './held-motion.ts';
import type { HandFrame } from './motion.ts';
import { crossingDirection, scaleConnection } from './scale-motion.ts';
import { planChord } from './chords.ts';

export type HeldPath={times:number[];positions:Vec3[];targets:Vec3[];linear?:boolean;crossings?:{from:number;to:number}[]};
type Range={low:number;high:number;target:Vec3;hover:number};
const HOVER=0.018,TRAVEL=0.01;
// Reachability depends on geometry, not the onset or length of the note.
const contactRanges=new Map<string,Range|undefined>();
const begin=(e:FingerEvent)=>e.note.time-e.approach;
const finish=(e:FingerEvent)=>e.note.time+e.note.duration+e.release;
const raised=(f:Finger):JointPose=>({...restPose(f),proximal:-0.65,distal:0.35});
const mixPose=(a:JointPose,b:JointPose,u:number):JointPose=>({spread:a.spread+(b.spread-a.spread)*u,
  proximal:a.proximal+(b.proximal-a.proximal)*u,distal:a.distal+(b.distal-a.distal)*u,
  opposition:(a.opposition??0)+((b.opposition??0)-(a.opposition??0))*u});

export function heldPalm(path:HeldPath,time:number):Vec3 {
  if(time<=path.times[0])return [...path.positions[0]];
  if(time>=path.times.at(-1)!)return [...path.positions.at(-1)!];
  let low=0,high=path.times.length-1;
  while(high-low>1) {
    const middle=(low+high)>>1;
    if(time<path.times[middle])high=middle;else low=middle;
  }
  const fraction=(time-path.times[low])/(path.times[high]-path.times[low]);
  const u=path.linear?fraction:ease(fraction);
  return path.positions[low].map((v,j)=>v+(path.positions[high][j]-v)*u) as Vec3;
}

function poseFor(hand:Hand,event:FingerEvent,target:Vec3,position:Vec3,height:number) {
  // Remove sub-picometer cancellation differences before reachability tests,
  // so mirrored/transposed grids choose the same feasible component.
  const local=target.map((v,i)=>Math.round((v-position[i]+(i===1?height:0))*1e12)/1e12) as Vec3;
  return solveFinger(hand,event.note.finger,local,!!event.opposed);
}

export function movingHeldFrame(plan:HeldPlan,hand:Hand,time:number):HandFrame {
  const {events}=plan,path=plan.path!,position=heldPalm(path,time);
  const active=events.map((event,index)=>({event,index})).filter(({event})=>time>=begin(event)&&time<finish(event));
  const joints={} as Record<Finger,JointPose>;
  for(const finger of fingers) {
    const sounding=active.find(({event})=>event.note.finger===finger);
    if(sounding) {
      const {event,index}=sounding;
      const pose=poseFor(hand,event,path.targets[index],position,fingerStroke(event,time).height);
      if(!pose)throw new Error('A finger cannot reach its contact point while the palm moves.');
      joints[finger]=pose;continue;
    }
    const indices=events.map((e,i)=>e.note.finger===finger?i:-1).filter(i=>i>=0);
    const previous=indices.filter(i=>finish(events[i])<=time).at(-1),next=indices.find(i=>begin(events[i])>time);
    const endpoint=(i:number,t:number)=>poseFor(hand,events[i],path.targets[i],heldPalm(path,t),fingerStroke(events[i],t).height)!;
    const wait=raised(finger);
    if(previous!==undefined&&next!==undefined) {
      const end=finish(events[previous]),start=begin(events[next]),u=(time-end)/(start-end);
      const direct=mixPose(endpoint(previous,end),endpoint(next,start),ease(u));
      joints[finger]=mixPose(direct,wait,16*u*u*(1-u)*(1-u));
    } else if(previous!==undefined) {
      const end=finish(events[previous]);joints[finger]=mixPose(endpoint(previous,end),wait,ease((time-end)/0.18));
    } else if(next!==undefined) {
      const start=begin(events[next]);joints[finger]=mixPose(wait,endpoint(next,start),ease((time-start+0.3)/0.3));
    } else joints[finger]=wait;
  }
  // Keep idle transitions above the key tops even when the palm moves down
  // into a wide pressed chord. Active/held contacts are never adjusted here.
  const drops=new Map(active.map(({event})=>[event.note.midiNote,fingerStroke(event,time).depth*TRAVEL]));
  if(events.some(event=>event.hover!==undefined))for(const finger of fingers) {
    if(active.some(({event})=>event.note.finger===finger))continue;
    const isClear=(pose:JointPose)=>{
      const points=pointsForPose(hand,finger,pose).map(point=>point.map((v,i)=>v+position[i]) as Vec3);
      return points[2][1]>=0.003&&clearsBlackKeys(points,new Set(),0,drops);
    };
    if(isClear(joints[finger]))continue;
    const tip=pointsForPose(hand,finger,joints[finger])[2];
    const raisedPose=tip[1]+position[1]<0.003?solveFinger(hand,finger,[tip[0],0.0035-position[1],tip[2]]):undefined;
    if(raisedPose&&isClear(raisedPose)) { joints[finger]=raisedPose;continue; }
    const original=joints[finger], raisedJoint=raised(finger);
    // Lift the distal segment too if the usual raised pose brushes a black key.
    const safe=isClear(raisedJoint)?raisedJoint:{...raisedJoint,distal:0};
    for(let i=1;i<=32;i++) {
      const pose=mixPose(original,safe,i/32);
      if(isClear(pose)){joints[finger]=pose;break;}
    }
  }
  const depths=active.map(({event})=>fingerStroke(event,time).depth);
  const substituting=active.some(({event})=>event.handoffFrom);
  const crossing=path.crossings?.some(c=>time>=begin(events[c.from])&&time<finish(events[c.to]));
  return {position,rotation:[0,0,0],lift:0,phase:active.some(({event:e})=>time>=e.note.time&&time<e.note.time+e.note.duration)?'press':
    active.some(({event:e})=>time<e.note.time)?'approach':active.length?'release':'waiting',
    active:active[0]?.event.note,activeNotes:active.map(({event})=>event.note),targets:active.map(({index})=>path.targets[index]),
    depths,depth:Math.max(0,...depths),curl:0,joints,
    technique:substituting?'substitution':crossing?'legato-crossing':'held-travel',strikeStyle:'smooth'};
}

// Find a conservative interval of palm X positions that reaches the whole
// vertical stroke. Contact Z remains fixed for this event for its entire life.
function contactRangeFor(hand:Hand,event:FingerEvent,y:number,z:number,zone?:[number,number],xOffset=0):Range|undefined {
  const id=JSON.stringify([hand,event.note.midiNote,event.note.finger,event.hover,!!event.opposed,y,z,zone,xOffset]);
  if(contactRanges.has(id))return contactRanges.get(id);
  const result=searchContactRange(hand,event,y,z,zone,xOffset);
  if(contactRanges.size>=8192)contactRanges.delete(contactRanges.keys().next().value!);
  contactRanges.set(id,result);
  return result;
}

function searchContactRange(hand:Hand,event:FingerEvent,y:number,z:number,zone: [number,number]|undefined,xOffset:number):Range|undefined {
  const key=keys.find(k=>k.midiNote===event.note.midiNote)!,finger=event.note.finger;
  const range=contactRange(key,true),back=Math.max(range[0],zone?.[0]??-Infinity),front=Math.min(range[1],zone?.[1]??Infinity);
  if(back>front)return;
  const root=pointsForPose(hand,finger,restPose(finger))[0];
  const center=key.target[0]+xOffset-root[0],preferred=z+pointsForPose(hand,finger,restPose(finger))[2][2];
  const depths=[Math.max(back,Math.min(front,preferred)),...Array.from({length:Math.ceil((front-back)/0.006)+1},(_,i)=>Math.min(front,back+i*0.006))];
  let best:Range|undefined,score=-Infinity;
  for(const depth of depths) {
    const target:Vec3=[key.target[0]+xOffset,key.target[1],depth];
    const reachable=(x:number)=>[-TRAVEL,0,(event.hover??HOVER)/2,event.hover??HOVER].every(height=>!!poseFor(hand,event,target,[x,y,z],height));
    const mirror=hand==='right'?1:-1;
    let first:number|undefined;
    for(let i=0;i<=40;i++) {
      const x=center+mirror*(-0.08+i*0.004),valid=reachable(x);
      if(valid&&first===undefined)first=x;
      if(first!==undefined&&(!valid||i===40)) {
        const last=valid?x:x-mirror*0.004;
        let a=Math.min(first,last),b=Math.max(first,last);
        if(a===b){first=undefined;continue;}
        // Stay inside the sampled component; dense validation checks the path.
        a+=0.0002;b-=0.0002;
        const value=b-a-0.02*Math.abs(depth-preferred);
        if(value>score+1e-10){best={low:a,high:b,target,hover:event.hover??HOVER};score=value;}
        first=undefined;
      }
    }
  }
  return best;
}

function pathFor(events:FingerEvent[],ranges:Range[],y:number,z:number):HeldPath|undefined {
  const times=[...new Set(events.flatMap(e=>[begin(e),finish(e)]))].sort((a,b)=>a-b);
  const bounds=times.map(t=>{
    const touching=events.map((e,i)=>begin(e)<=t+1e-9&&finish(e)>=t-1e-9?i:-1).filter(i=>i>=0);
    return {low:Math.max(...touching.map(i=>ranges[i].low)),high:Math.min(...touching.map(i=>ranges[i].high))};
  });
  if(bounds.some(b=>b.low>b.high))return;
  // Minimize neighboring movement with box constraints. Looking both ways lets
  // the hand prepare while an earlier finger is still holding its own key.
  const xs=bounds.map(b=>(b.low+b.high)/2),preferred=[...xs];
  for(let pass=0;pass<120;pass++)for(let offset=0;offset<xs.length;offset++) {
    const i=pass%2?xs.length-1-offset:offset,b=bounds[i];
    let sum=preferred[i]*0.03,weight=0.03;
    for(const j of [i-1,i+1])if(j>=0&&j<xs.length) {
      const w=1/Math.max(0.01,Math.abs(times[i]-times[j]));sum+=xs[j]*w;weight+=w;
    }
    xs[i]=Math.max(b.low,Math.min(b.high,sum/weight));
  }
  return {times,positions:xs.map(x=>[x,y,z]),targets:ranges.map(r=>r.target)};
}

function pathClear(plan:HeldPlan,hand:Hand):boolean {
  const path=plan.path!,start=path.times[0],end=path.times.at(-1)!,count=Math.ceil((end-start)/0.003);
  const times=new Set([...path.times,...Array.from({length:count+1},(_,i)=>start+(end-start)*i/count)]);
  for(let i=1;i<path.times.length;i++)times.add((path.times[i-1]+path.times[i])/2);
  for(const e of plan.events)for(const t of [e.note.time,e.note.time+Math.min(0.06,e.note.duration),e.note.time+e.note.duration,
    e.note.time+e.note.duration+e.release*0.65,begin(e)-0.3,finish(e)+0.18])if(t>=start&&t<=end)times.add(t);
  try {
    for(const t of times) {
      const frame=movingHeldFrame(plan,hand,t),drops=new Map(frame.activeNotes.map((n,i)=>[n.midiNote,frame.depths![i]*TRAVEL]));
      for(const f of fingers) {
        const points=pointsForPose(hand,f,frame.joints[f]).map(p=>p.map((v,i)=>v+frame.position[i]) as Vec3);
        if(!clearsBlackKeys(points,new Set(),0,drops)||!frame.activeNotes.some(n=>n.finger===f)&&points[2][1]<0.003)return false;
      }
    }
  } catch {return false;}
  return true;
}

export function planHeldPath(hand:Hand,events:FingerEvent[]):HeldPlan {
  const crossings:{from:number;to:number}[]=[];
  for(let i=0;i<events.length;i++)for(let j=i+1;j<events.length;j++) {
    const a=events[i],b=events[j];
    if(a.note.finger!==b.note.finger&&begin(a)<=finish(b)&&begin(b)<=finish(a)&&
      (a.note.midiNote-b.note.midiNote)*(a.note.finger-b.note.finger)*(hand==='right'?1:-1)<0)
      {
        if(scaleConnection(a.note,b.note)!=='crossing'||!crossingDirection(a.note,b.note))
          throw new Error('This crossed held passage is unsupported. Only semitone/whole-tone 3-to-1 or 4-to-1 crossings are supported.');
        (a.note.finger===1?a:b).opposed=true;crossings.push({from:i,to:j});
      }
  }
  // Substituting fingers use distinct depths on the same key, rather than
  // assigning both fingertips the same point. Longer fingers take the rear.
  const zones=events.map(e=>{
    const peers=[...new Set([e.note.finger,...events.filter(p=>p.handoffFrom===e.note||e.handoffFrom===p.note).map(p=>p.note.finger)])]
      .sort((a,b)=>{const length=(f:Finger)=>{const p=pointsForPose(hand,f,restPose(f));return Math.hypot(...p[2].map((v,i)=>v-p[0][i]));};return length(b)-length(a)||a-b;});
    if(peers.length<2)return;
    const key=keys.find(k=>k.midiNote===e.note.midiNote)!,center=key.target[2]+(peers.indexOf(e.note.finger)-(peers.length-1)/2)*0.018;
    return [center-0.002,center+0.002] as [number,number];
  });
  const offsets=events.map(()=>0),counts=events.map(()=>0);
  for(const {from,to} of crossings)for(const [i,j] of [[from,to],[to,from]]) {
    const key=keys.find(k=>k.midiNote===events[i].note.midiNote)!;
    offsets[i]+=Math.sign(events[j].note.midiNote-events[i].note.midiNote)*(key.width/2-0.003);counts[i]++;
  }
  // An octave can require an inset contact, including on a key held through
  // later attacks. Keep that contact on the same point throughout the path.
  for(const [i,a] of events.entries())for(const [j,b] of events.entries()) {
    if(i===j||a.note.time>=end(b)||b.note.time>=end(a))continue;
    const key=keys.find(k=>k.midiNote===a.note.midiNote)!;
    const other=keys.find(k=>k.midiNote===b.note.midiNote)!;
    if(Math.abs(key.target[0]-other.target[0])<0.14)continue;
    offsets[i]+=Math.sign(other.target[0]-key.target[0])*(key.width/2-0.003);counts[i]++;
  }
  for(const hover of [HOVER,0.012,0.006,0.003,0.001])
  for(const factor of counts.some(Boolean)?[0,0.5,1]:[0])
  for(const y of [-0.025,-0.02,-0.015,-0.01,-0.005,0,-0.03])for(const z of [0.03,0.02,0.01,0,-0.01,-0.02,-0.03,-0.04,0.04]) {
    const ranges=events.map((e,i)=>contactRangeFor(hand,{...e,hover},y,z,zones[i],factor*offsets[i]/Math.max(1,counts[i])));
    if(ranges.some(r=>!r))continue;
    const path=pathFor(events,ranges as Range[],y,z);if(!path)continue;
    if(crossings.length)path.crossings=crossings;
    const plan:HeldPlan={events:events.map((event,i)=>({...event,hover:ranges[i]!.hover})),path,geometry:{position:path.positions[0],contacts:[]}};
    if(pathClear(plan,hand))return plan;
  }
  if(!crossings.length&&!events.some(event=>event.handoffFrom)) {
    for(const preferDense of [false,true]) {
      const targets=pressedTargets(hand,events,preferDense);
      if(!targets)continue;
      // Reconsider the starting contact of a sustained key if later attacks
      // need a different palm position. Each trial keeps the target fixed.
      const anchorOnsets=new Set(events.filter(event=>events.some(next=>
        next.note.time>event.note.time&&next.note.time<end(event))).map(event=>event.note.time));
      const targetOptions=[targets];
      if(anchorOnsets.size)for(const shift of [-0.015,-0.025,-0.035,0.01]) {
        targetOptions.push(targets.map((target,i)=>{
          if(!anchorOnsets.has(events[i].note.time))return target;
          const key=keys.find(key=>key.midiNote===events[i].note.midiNote)!;
          const [back,front]=contactRange(key,true);
          return [target[0],target[1],Math.max(back,Math.min(front,target[2]+shift))];
        }));
      }
      for(const window of [0.12,0.06,0.03,0.01,0.003]) {
        for(const contacts of targetOptions) {
          const phased=phasePath(hand,events,window,contacts);
          if(phased)return phased;
        }
      }
    }
  }
  throw new Error('No continuous palm path satisfies the held contacts, joint limits and black-key clearance of this model.');
}

/** Fallback for chords whose press is reachable but whose fingers cannot all
 * hover at one fixed palm height. Targets stay fixed; actual strokes constrain
 * the palm at each time, including contacts held through another voice's onset. */
function pressedTargets(hand:Hand,events:FingerEvent[],preferDense:boolean):Vec3[]|undefined {
  const targets=events.map(event=>[...keys.find(key=>key.midiNote===event.note.midiNote)!.target] as Vec3);
  const assigned=new Set<number>();
  // Select contact depths from pressed poses, without imposing a hover on held fingers.
  const activeSets=[...new Set(events.map(event=>event.note.time))].map(time=>
    events.map((event,index)=>({event,index})).filter(({event})=>event.note.time<=time&&end(event)>time));
  // On a roll, the largest set has the tightest geometry. Try choosing
  // contacts from that pose before planning the earlier partial chords.
  if(preferDense)activeSets.sort((a,b)=>b.length-a.length);
  for(const active of activeSets) {
    if(active.every(({index})=>assigned.has(index)))continue;
    if(new Set(active.map(({event})=>event.note.finger)).size!==active.length)continue;
    try {
      const chord=planChord(hand,active.map(({event,index})=>({finger:event.note.finger,midiNote:event.note.midiNote,target:targets[index]})),0,TRAVEL);
      for(const {event,index} of active) if(!assigned.has(index)){targets[index]=chord.contacts.find(contact=>contact.finger===event.note.finger)!.target;assigned.add(index);}
    } catch {return;}
  }
  return targets;
}

function phasePath(hand:Hand,source:FingerEvent[],window:number,targets:Vec3[]):HeldPlan|undefined {
  const first=Math.min(...source.map(event=>event.note.time));
  const events=source.map(event=>({...event,hover:0.003,approach:event.note.time===first?event.approach:Math.min(event.approach,window),release:Math.min(event.release,window)}));
  const start=Math.min(...events.map(begin)),stop=Math.max(...events.map(finish));
  const count=Math.ceil((stop-start)/0.0015);
  const times=[...new Set([start,stop,...events.flatMap(event=>[begin(event),event.note.time,event.note.time+Math.min(0.06,event.note.duration),end(event),finish(event)]),
    ...Array.from({length:count+1},(_,i)=>start+(stop-start)*i/count)])].sort((a,b)=>a-b);
  const positions:Vec3[]=[];
  for(const time of times) {
    const active=events.map((event,index)=>({event,index})).filter(({event})=>begin(event)<=time+1e-9&&finish(event)>=time-1e-9);
    if(!active.length) { positions.push([...(positions.at(-1)??[0,0,0.02])] as Vec3);continue; }
    const center=active.reduce((sum,{event,index})=>sum+targets[index][0]-pointsForPose(hand,event.note.finger,restPose(event.note.finger))[0][0],0)/active.length;
    const strokes=active.map(({event})=>fingerStroke(event,time));
    const drops=new Map(active.map(({event},i)=>[event.note.midiNote,strokes[i].depth*TRAVEL]));
    const previous=positions.at(-1);
    const reachable=(position:Vec3)=>active.every(({event,index},i)=>{
      const pose=poseFor(hand,event,targets[index],position,strokes[i].height);
      if(!pose)return false;
      const points=pointsForPose(hand,event.note.finger,pose).map(point=>point.map((v,j)=>v+position[j]) as Vec3);
      return clearsBlackKeys(points,new Set(),0,drops);
    });
    if(previous&&reachable(previous)){positions.push(previous);continue;}
    let chosen:Vec3|undefined,best=Infinity;
    for(const y of [-0.03,-0.025,-0.02,-0.015,-0.01,-0.005,0,0.005,0.01])
    for(const z of [0.02,0.03,0.01,0,0.04,-0.01,-0.02,-0.03,-0.04])
    for(let dx=-0.05;dx<=0.05001;dx+=0.0025) {
      const position:Vec3=[center+dx,y,z];
      const score=previous?position.reduce((sum,v,i)=>sum+(v-previous[i])**2,0):dx*dx+(z-0.02)**2+y*y*0.1;
      if(score>=best)continue;
      if(!reachable(position))continue;
      if(score<best){best=score;chosen=position;}
    }
    if(!chosen)return;
    positions.push(chosen);
  }
  const path:HeldPath={times,positions,targets,linear:true};
  const plan:HeldPlan={events,path,geometry:{position:positions[0],contacts:[]}};
  return pathClear(plan,hand)?plan:undefined;
}
const end=(event:FingerEvent)=>event.note.time+event.note.duration;
