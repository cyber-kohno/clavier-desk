import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { DOMParser } from '@xmldom/xmldom';
import MusicXmlFileController from '../src/service/project/musicxml-file-controller.ts';
import FileController from '../src/service/project/score-project-file-controller.ts';
import Factory from '../src/domain/score/score-project.ts';
import Dialog from '../src/service/dialog/editor-dialog-controller.ts';
import { editorDialogStore } from '../src/state/editor-dialog.ts';
import { get } from 'svelte/store';

globalThis.DOMParser = DOMParser;
const xml = '<score-partwise><part id="P1"><measure><attributes><divisions>1</divisions><staves>2</staves></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type><staff>1</staff></note></measure></part></score-partwise>';

function bridge(t, invoke) {
  const previous = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: { invoke } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
}

test('opens the native MusicXML filter, reads the selected file, and converts it', async t => {
  const calls = [];
  bridge(t, async (command, args) => {
    calls.push({ command, args });
    return command === 'plugin:dialog|open' ? 'C:/scores/ピアノ.musicxml' : new TextEncoder().encode(xml);
  });
  const result = await MusicXmlFileController.load();
  assert.equal(result.type, 'success');
  assert.deepEqual(calls[0].args.options.filters[0].extensions, ['musicxml', 'xml']);
  assert.equal(calls[0].args.options.multiple, false);
  assert.equal(calls[1].args.path, 'C:/scores/ピアノ.musicxml');
  assert.equal(result.value.project.outline.at(-1).type, 'measure');
});

test('cancelling the native dialog does not read or parse a file', async t => {
  let calls = 0;
  bridge(t, async () => { calls++; return null; });
  assert.deepEqual(await MusicXmlFileController.load(), { type: 'cancelled' });
  assert.equal(calls, 1);
});

test('returns a recoverable error for native failures and invalid XML', async t => {
  bridge(t, async () => { throw new Error('Read denied'); });
  assert.deepEqual(await MusicXmlFileController.load(), { type: 'error', message: 'Read denied' });
  window.__TAURI_INTERNALS__.invoke = async command => command === 'plugin:dialog|open' ? 'broken.xml' : new TextEncoder().encode('<other/>');
  assert.equal((await MusicXmlFileController.load()).type, 'error');
});

// Execute the actual App functions, including the shortcut and save flow, with
// native IO mocked. This catches wiring regressions without duplicating the UI logic.
function app(t, { dirty = false, allowed = true, playing = false } = {}) {
  Dialog.close();
  t.after(() => Dialog.close());
  const component = readFileSync(new URL('../src/App.svelte', import.meta.url), 'utf8');
  const script = component.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  const ast = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
  const names = ['applyLoadedProject', 'closeHairpinMode', 'importMusicXml', 'saveProject', 'handleKeydown'];
  const functions = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text)).map(statement => statement.getText(ast)).join('\n');
  assert.equal(functions.includes('async function importMusicXml'), true);
  const source = `
    const { initial, dirty, allowed, playing, MusicXmlFileController, ScoreProjectFileController, EditorDialogController } = dependencies;
    let project = initial, currentProjectFile = {path:'original.clavierdesk', name:'original.clavierdesk'},
      savedProjectFingerprint = 'original', projectIsDirty = dirty, fileOperationInProgress = false,
      outlineCursor, timelineCursor, mode, pedalMode, ottavaMode, hairpinMode, hairpinStart, hairpinDialog = null,
      menuPath = null, noteSettings = null,
      sectionTextInput = null, fingeringTextInput = null, fingeringSession = null, passageClipboard, savedPlaybackFocus, playbackPosition;
    const mcpCheckout = false, animationOpen = false;
    const HTMLElement = class {};
    const uiEditAllowed = () => allowed;
    const createOutlineCursor = () => ({}), createTimelineCursor = () => ({});
    const playback = { playing, stop(){} }, notePreview = { stop(){} }, keyHold = {reset(){}};
    const captureHistorySnapshot = () => ({project});
    let historyReset = 0;
    const editorHistory = {reset(){historyReset++;}};
    const showProjectFileError = () => {throw new Error('Unexpected save error');};
    ${functions}
    return { importMusicXml, saveProject, handleKeydown,
      get project(){return project;}, get handle(){return currentProjectFile;},
      get dirty(){return JSON.stringify(project) !== savedProjectFingerprint;},
      get busy(){return fileOperationInProgress;}, get historyReset(){return historyReset;} };
  `;
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function('dependencies', js)({ initial: Factory.create(), dirty, allowed, playing,
    MusicXmlFileController, ScoreProjectFileController: FileController, EditorDialogController: Dialog });
}

test('Ctrl+I imports as dirty, resets history, and Ctrl+S uses Save As', async t => {
  const imported = Factory.create();
  imported.outline[1].data.name = 'Imported';
  t.mock.method(MusicXmlFileController, 'load', async () => ({ type: 'success', value: { project: imported, warnings: [] } }));
  const state = app(t);
  let prevented = false;
  state.handleKeydown({ key: 'i', ctrlKey: true, preventDefault(){prevented = true;} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(state.project, imported);
  assert.equal(state.handle, null);
  assert.equal(state.dirty, true);
  assert.equal(state.historyReset, 1);
  Dialog.close();
  const savedHandle = { path: 'new.clavierdesk', name: 'new.clavierdesk' };
  const saveAs = t.mock.method(FileController, 'saveAs', async project => ({ type: 'success', value: { handle: savedHandle, fingerprint: JSON.stringify(project) } }));
  state.handleKeydown({ key: 's', ctrlKey: true, preventDefault(){} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saveAs.mock.callCount(), 1);
  assert.equal(state.handle, savedHandle);
  assert.equal(state.dirty, false);
});

test('discard confirmation preserves the current project until the user accepts', async t => {
  const imported = Factory.create();
  t.mock.method(MusicXmlFileController, 'load', async () => ({ type: 'success', value: { project: imported, warnings: [{ code: 'range', message: 'Out of range pitches omitted.', count: 2, measure: 3 }] } }));
  const state = app(t, { dirty: true });
  const before = state.project;
  await state.importMusicXml();
  assert.equal(state.project, before);
  assert.equal(get(editorDialogStore).focus, 1);
  Dialog.choose(1);
  assert.equal(state.project, before);
  await state.importMusicXml();
  Dialog.choose(0);
  assert.equal(state.project, imported);
  assert.match(get(editorDialogStore).messageLines.join('\n'), /measures 3/);
});

test('cancelled and failed imports preserve the project and its save destination', async t => {
  const load = t.mock.method(MusicXmlFileController, 'load', async () => ({ type: 'cancelled' }));
  const state = app(t);
  const before = state.project, handle = state.handle;
  await state.importMusicXml();
  assert.equal(state.project, before);
  assert.equal(state.handle, handle);
  assert.equal(state.busy, false);
  load.mock.mockImplementation(async () => ({ type: 'error', message: 'Invalid XML' }));
  await state.importMusicXml();
  assert.equal(state.project, before);
  assert.equal(state.handle, handle);
  assert.equal(state.historyReset, 0);
  assert.equal(get(editorDialogStore).title, 'MusicXML Import Failed');
});

test('does not open the import dialog during playback or MCP checkout', async t => {
  const load = t.mock.method(MusicXmlFileController, 'load', async () => ({ type: 'cancelled' }));
  await app(t, { playing: true }).importMusicXml();
  await app(t, { allowed: false }).importMusicXml();
  assert.equal(load.mock.callCount(), 0);
});
