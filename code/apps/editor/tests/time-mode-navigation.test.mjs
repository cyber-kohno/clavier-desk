import assert from 'node:assert/strict';
import { test } from 'node:test';
import Factory from '../src/domain/score/score-project.ts';
import Measure from '../src/domain/score/score-measure.ts';
import Navigation from '../src/state/editor-navigation.ts';
import PedalInput from '../src/state/pedal-input.ts';
import OttavaInput from '../src/state/ottava-input.ts';
import { addTimelineNoteAt, convertFocusedTimelineTuplet, getTimelineInputSixteenths, createTimelineCursor } from '../src/state/timeline-cursor.ts';

const key = key => ({ key, code: key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false });
function fixture() {
  const project = Factory.create();
  for (let i = 0; i < 2; i++) project.outline.push({ id: `m${i}`, type: 'measure', data: Measure.create({ cnt: 4, unit: 4 }) });
  const timelineCursor = { ...createTimelineCursor('lowerStaff'), positionSixteenths: 12,
    pitch: 43, placementValue: { type: 'eighth', dots: 1 }, focusedNoteId: 'old',
    focusedGraceId: 'grace', focusedPitchIndex: 1, selectionAnchorNoteId: 'anchor' };
  return { project, timelineCursor, outlineCursor: { blockId: 'm0' } };
}

for (const mode of ['pedal', 'ottava']) test(`${mode} movement, edit and exit retain the shared timeline position and input settings`, () => {
  const { project, ...initial } = fixture();
  let state = Navigation.moveToTime(project.outline, initial.outlineCursor, initial.timelineCursor, 12);
  let cursor = Navigation.timeCursor(state.timelineCursor);
  const control = input => mode === 'pedal' ? PedalInput.control(project, cursor, key(input))
    : OttavaInput.control(project, cursor, state.timelineCursor.staff, key(input));
  for (const input of ['ArrowRight', 'ArrowRight', 'a', 'Escape']) {
    const result = control(input);
    cursor = result.cursor;
    state = Navigation.applyTimeCursor(project.outline, state.outlineCursor, state.timelineCursor, cursor);
    if (input === 'a') {
      assert.equal(result.command.position, 18);
      if (mode === 'ottava') assert.equal(result.command.staff, 'lowerStaff');
    }
    if (input === 'Escape') assert.equal(result.exit, true);
  }
  assert.equal(state.timelineCursor.positionSixteenths, 18);
  assert.equal(state.outlineCursor.blockId, 'm1');
  assert.equal(state.timelineCursor.staff, 'lowerStaff');
  assert.equal(state.timelineCursor.pitch, 43);
  assert.deepEqual(state.timelineCursor.placementValue, { type: 'eighth', dots: 1 });
  for (const field of ['focusedNoteId', 'focusedGraceId', 'focusedPitchIndex', 'selectionAnchorNoteId']) assert.equal(state.timelineCursor[field], null);
  assert.equal(cursor.position, state.timelineCursor.positionSixteenths);
});

test('time-only navigation reconciles a missing voice without changing the requested time', () => {
  const { project, outlineCursor, timelineCursor } = fixture();
  const next = Navigation.moveToTime(project.outline, outlineCursor, { ...timelineCursor, voiceIndex: 2 }, 20);
  assert.equal(next.timelineCursor.voiceIndex, 0);
  assert.equal(next.timelineCursor.positionSixteenths, 20);
  assert.equal(next.outlineCursor.blockId, 'm1');
});

for (const mode of ['pedal', 'ottava']) test(`${mode} shares value changes and preserves a tuplet offset without adopting its step`, () => {
  const base = fixture();
  const placed = addTimelineNoteAt(base.project, { ...createTimelineCursor(), placementValue: { type: 'quarter', dots: 0 } }, 0, 60);
  const tuple = convertFocusedTimelineTuplet(placed.project, placed.cursor);
  const start = 4 / 3;
  let state = Navigation.moveToTime(tuple.project.outline, base.outlineCursor, tuple.cursor, start);
  assert.equal(getTimelineInputSixteenths(state.timelineCursor, tuple.project.outline), start);
  let cursor = Navigation.timeCursor(state.timelineCursor);
  assert.deepEqual(cursor.value, { type: 'quarter', dots: 0 });
  const control = input => mode === 'pedal' ? PedalInput.control(tuple.project, cursor, key(input))
    : OttavaInput.control(tuple.project, cursor, state.timelineCursor.staff, key(input));
  // Switching mode does not round the fractional starting position.
  assert.equal(cursor.position, start);
  const moved = control('ArrowRight');
  assert.ok(Math.abs(moved.cursor.position - (start + 4)) < 1e-9);
  state = Navigation.applyTimeCursor(tuple.project.outline, state.outlineCursor, state.timelineCursor, moved.cursor);
  cursor = Navigation.timeCursor(state.timelineCursor);
  const changed = control('2');
  state = Navigation.applyTimeCursor(tuple.project.outline, state.outlineCursor, state.timelineCursor, changed.cursor);
  assert.deepEqual(state.timelineCursor.placementValue, { type: 'eighth', dots: 0 });
  // The other time-only tool sees this same value and position immediately.
  cursor = Navigation.timeCursor(state.timelineCursor);
  const other = mode === 'pedal' ? OttavaInput.control(tuple.project, cursor, 'upperStaff', key('ArrowRight'))
    : PedalInput.control(tuple.project, cursor, key('ArrowRight'));
  assert.ok(Math.abs(other.cursor.position - (start + 6)) < 1e-9);
});
