import assert from 'node:assert/strict';
import { test } from 'node:test';
import ScoreFingerings from '../src/domain/score/score-fingerings.ts';
import FingeringInput from '../src/state/fingering-input.ts';
import NotePitches from '../src/domain/score/note-pitches.ts';
import Factory from '../src/domain/score/score-project.ts';
import Measure from '../src/domain/score/score-measure.ts';
import Timeline from '../src/domain/score/score-timeline.ts';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import NoteEditor from '../src/action/editor/note-editor.ts';
import ScoreTrill from '../src/domain/score/score-trill.ts';
import FloatingText from '../src/state/floating-text-input.ts';
import History from '../src/service/history/editor-history.ts';

const grace = (id, midi, fingering) => ({id, value:{type:'eighth',dots:0}, slash:true,
  pitches:[{midi,...(fingering === undefined ? {} : {fingering})}]});
const chord = () => ({id:'chord',kind:'note',value:{type:'whole',dots:0},
  pitches:[{midi:67,fingering:5},{midi:64,fingering:1,substitutionFingering:2},{midi:60,fingering:3}]});

test('chord input excludes itself, reserves only sibling initial fingers, and checks both entered fingers',()=>{
  const rules=ScoreFingerings.rules(chord(),0);
  assert.deepEqual([...rules.usedFingerings],[1,3]);
  assert.deepEqual(FingeringInput.parse('5',rules),{fingering:5});
  assert.deepEqual(FingeringInput.parse('2-4',rules),{fingering:2,substitutionFingering:4});
  for(const value of ['1','3','1-4','4-1','3-2','2-3','2-2','0','6','1-2-3']) {
    assert.equal(FingeringInput.parse(value,rules),undefined,value);
  }
});

test('empty and whitespace-only input request removal independently of reserved fingers',()=>{
  for (const rules of [ScoreFingerings.rules(chord(), 0), { usedFingerings: new Set([1,2,3,4,5]), allowSubstitution: false }]) {
    for (const value of ['', ' ', '   ', '\t\n', '　']) assert.equal(FingeringInput.parse(value, rules), null);
    for (const value of ['0', '6', '-', '1-', '1-1']) assert.equal(FingeringInput.parse(value, rules), undefined);
  }
});

test('parent and all attached graces reserve fingers mutually, and grace input rejects substitution',()=>{
  const note={id:'parent',kind:'note',value:{type:'quarter',dots:0},
    pitches:[{midi:60,fingering:1,substitutionFingering:2}],
    beforeGraceNotes:[grace('a',59,3),grace('b',58,4),grace('c',57)]};
  const rules=ScoreFingerings.rules(note,0,'a');
  assert.deepEqual([...rules.usedFingerings],[1,4]);
  assert.deepEqual(FingeringInput.parse('3',rules),{fingering:3});
  assert.deepEqual(FingeringInput.parse('2',rules),{fingering:2});
  for(const value of ['1','4','2-5','3-2']) assert.equal(FingeringInput.parse(value,rules),undefined,value);
  const parentRules=ScoreFingerings.rules(note,0);
  assert.equal(FingeringInput.parse('3',parentRules),undefined);
  assert.equal(FingeringInput.parse('4',parentRules),undefined);
  assert.deepEqual(FingeringInput.parse('1-2',parentRules),{fingering:1,substitutionFingering:2});
  // The rules captured on opening remain a snapshot until the input is reopened.
  note.beforeGraceNotes[1].pitches[0].fingering=5;
  assert.equal(FingeringInput.parse('4',rules),undefined);
  assert.deepEqual(FingeringInput.parse('4',ScoreFingerings.rules(note,0,'a')),{fingering:4});
});

test('domain refuses sibling collisions atomically and allows reuse of a sibling substitution finger',()=>{
  const project=Factory.create();
  const data=Measure.create({unit:4,cnt:4});
  data.upperStaff.voices[0].elements=[chord()];
  project.outline.push({id:'m',type:'measure',data});
  const before=structuredClone(project), target={noteId:'chord',staff:'upperStaff',pitchIndex:0};
  assert.equal(NotePitches.setFingering(project,target,1),project);
  assert.equal(NotePitches.setFingering(project,target,4,3),project);
  const updated=NotePitches.setFingering(project,target,2,4);
  assert.deepEqual(Timeline.note(updated.outline,'chord').note.pitches[0],{midi:67,fingering:2,substitutionFingering:4});
  assert.deepEqual(project,before);
  const cleared=NotePitches.setFingering(updated,target,null);
  assert.deepEqual(Timeline.note(cleared.outline,'chord').note.pitches[0],{midi:67});
});

function floatingEditor({ tied = false, graceFocus = false, unassigned = false, glissando = false } = {}) {
  let initial = Factory.create();
  const data = Measure.create({ unit: 4, cnt: 4 });
  data.upperStaff.voices[0].elements = [{ id: 'head', kind: 'note', value: { type: 'quarter', dots: 0 },
    pitches: [{ midi: 60, ...(unassigned ? {} : { fingering: 1, substitutionFingering: 2 }) }],
    ...(tied ? { tieTo: 'tail' } : {}), ...(graceFocus ? { beforeGraceNotes: [grace('g', 59, 4)] } : {}) },
    ...(tied ? [{ id: 'tail', kind: 'note', value: { type: 'quarter', dots: 0 }, pitches: [{ midi: 60 }], tieFrom: 'head' }] : [])];
  initial.outline.push({ id: 'm', type: 'measure', data });
  if (glissando) {
    data.upperStaff.voices[0].elements.push(
      { id: 'end', kind: 'note', value: { type: 'quarter', dots: 0 }, pitches: [{ midi: 67 }] },
      { id: 'rest', kind: 'rest', value: { type: 'half', dots: 0 } },
    );
    initial = NoteEditor.connectGlissando(initial, ['head', 'end']);
  }
  const source = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8').match(/<script lang="ts">([\s\S]*?)<\/script>/)[1];
  const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['openFingeringTextInput', 'controlFloatingText', 'commitFingeringText'];
  const handlers = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
  const js = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('deps', `
    const {initial,tied,graceFocus,ScoreTimeline,ScoreTrill,ScoreFingerings,FloatingText,FingeringInput,NoteEditor,History}=deps;
    let project=initial, fingeringTextInput=null, sectionTextInput=null, writes=0;
    const mode='timeline',pedalMode=false,ottavaMode=false,playback=null,selectedTimelineNotes=[{}];
    const focusedNoteId=tied&&!graceFocus?'tail':'head';
    const timelineCursor={staff:'upperStaff',voiceIndex:0,focusedNoteId,focusedPitchIndex:0,focusedGraceId:graceFocus?'g':null};
    const document={querySelectorAll:()=>[{dataset:{fingeringPitch:(graceFocus?'g':focusedNoteId)+':0'}}]};
    const getFocusedGrace=()=>graceFocus?{grace:ScoreTimeline.note(project.outline,'head').note.beforeGraceNotes[0]}:undefined;
    const keyHold={reset(){}},uiEditAllowed=()=>true,history=History.create({project});
    const recordProjectChange=before=>{if(before!==project){writes++;history.record({project});}};
    const commitSectionText=()=>{};
    ${js}
    return {open:openFingeringTextInput,key:key=>controlFloatingText({key,preventDefault(){}}),history,
      get project(){return project},get draft(){return fingeringTextInput},get writes(){return writes}};
  `)({ initial, tied, graceFocus, ScoreTimeline: Timeline, ScoreTrill, ScoreFingerings, FloatingText, FingeringInput, NoteEditor, History });
}

test('actual W input allows empty drafts, cancels without edits, and clears ordinary/substitution/tie/grace fingers in one undo', () => {
  for (const options of [{}, { tied: true }, { tied: true, graceFocus: true }]) {
    const ui = floatingEditor(options), original = ui.project, before = structuredClone(original);
    assert.equal(ui.open(), true);
    const originalText = ui.draft.value;
    for (const _ of originalText) ui.key('Backspace');
    assert.equal(ui.draft.value, ''); assert.strictEqual(ui.project, original);
    ui.key('Escape'); assert.equal(ui.draft, null); assert.equal(ui.writes, 0);
    ui.open(); for (const _ of originalText) ui.key('Backspace');
    ui.key(' '); ui.key(' '); ui.key('Enter');
    assert.equal(ui.draft, null); assert.equal(ui.writes, 1);
    const head = Timeline.note(ui.project.outline, 'head').note;
    if (options.graceFocus) {
      assert.deepEqual(head.beforeGraceNotes[0].pitches, [{ midi: 59 }]);
      assert.deepEqual(head.pitches, [{ midi: 60, fingering: 1, substitutionFingering: 2 }]);
    } else assert.deepEqual(head.pitches, [{ midi: 60 }]);
    if (options.tied) assert.deepEqual(Timeline.note(ui.project.outline, 'tail').note.pitches, [{ midi: 60 }]);
    assert.deepEqual(original, before);
    const cleared = ui.project;
    assert.strictEqual(ui.history.undo().project, original); assert.strictEqual(ui.history.redo().project, cleared);
  }
});

test('actual W input keeps invalid text uncommitted and empty confirmation on an unassigned pitch adds no history', () => {
  const ui = floatingEditor(), original = ui.project;
  ui.open(); for (const _ of ui.draft.value) ui.key('Backspace');
  ui.key('-'); ui.key('Enter');
  assert.equal(ui.draft.value, '-'); assert.strictEqual(ui.project, original); assert.equal(ui.writes, 0);
  ui.key('Escape'); assert.equal(ui.draft, null);
  const empty = floatingEditor({ unassigned: true }), untouched = empty.project;
  empty.open(); empty.key('Enter');
  assert.equal(empty.draft, null); assert.strictEqual(empty.project, untouched); assert.equal(empty.writes, 0);
});

test('actual W input does not open for a glissando endpoint', () => {
  const ui = floatingEditor({ glissando: true });
  assert.equal(ui.project.glissandi.length, 1);
  assert.equal(ui.open(), false);
  assert.equal(ui.draft, null);
  assert.equal(ui.writes, 0);
});
