import type { ScoreProject } from '../domain/score/types.ts';
import type { OutlineCursor } from './outline-cursor.ts';
import { reconcileTimelineCursorVoice, resetTimelineCursorForStaff, type TimelineCursor } from './timeline-cursor.ts';
import ScoreTimeline from '../domain/score/score-timeline.ts';
export type WorkspaceState = { project: ScoreProject; outlineCursor: OutlineCursor; timelineCursor: TimelineCursor; mode: 'outline' | 'timeline' };
namespace EditorNavigation {
  /** Adapter for time-only tools; never uses the tuplet-derived input step. */
  export function timeCursor(cursor: TimelineCursor) {
    return { position: cursor.positionSixteenths, value: cursor.placementValue };
  }
  export function applyTimeCursor(outline: ScoreProject['outline'], outlineCursor: OutlineCursor, timelineCursor: TimelineCursor,
    cursor: ReturnType<typeof timeCursor>) {
    return moveToTime(outline, outlineCursor, { ...timelineCursor, placementValue: { ...cursor.value } }, cursor.position);
  }
  /** Time-only modes retain pitch/input settings, but cannot retain an old note focus. */
  export function moveToTime(outline: ScoreProject['outline'], outlineCursor: OutlineCursor, timelineCursor: TimelineCursor, position: number) {
    return sync(outline, outlineCursor, {
      ...timelineCursor, positionSixteenths: position,
      focusedNoteId: null, focusedGraceId: null, focusedPitchIndex: null, selectionAnchorNoteId: null,
    });
  }
  export function sync(outline: ScoreProject['outline'], outlineCursor: OutlineCursor, timelineCursor: TimelineCursor, position = timelineCursor.positionSixteenths) {
    const next = reconcileTimelineCursorVoice(outline, timelineCursor), block = ScoreTimeline.blockAt(outline, position);
    return { timelineCursor: next, outlineCursor: block && block.id !== outlineCursor.blockId ? { blockId: block.id } : outlineCursor };
  }
  export function toggle(state: WorkspaceState): WorkspaceState {
    if (state.mode === 'timeline') return { ...state, mode: 'outline', timelineCursor: { ...state.timelineCursor, selectionAnchorNoteId: null } };
    const focusedIndex = state.project.outline.findIndex(block => block.id === state.outlineCursor.blockId);
    if (focusedIndex < 0 || !state.project.outline.slice(focusedIndex).some(block => block.type === 'measure')) return state;
    const position = ScoreTimeline.outlinePosition(state.project.outline, state.outlineCursor.blockId);
    const inner = state.outlineCursor.innerFocus;
    const reset = resetTimelineCursorForStaff(state.project.outline, { ...state.timelineCursor, positionSixteenths: position }, inner?.staff ?? 'upperStaff');
    const timelineCursor = { ...reset, voiceIndex: inner?.voiceIndex ?? reset.voiceIndex };
    const block = ScoreTimeline.blockAt(state.project.outline, position);
    return { ...state, mode: 'timeline', timelineCursor, outlineCursor: block ? { blockId: block.id } : state.outlineCursor };
  }
}
export default EditorNavigation;
