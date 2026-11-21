import { maxVelocityOffset } from '../domain/score/pitch-velocity.ts';
import type { ScoreProject } from '../domain/score/types.ts';
import type { LocatedTimelineNote } from '../domain/score/score-timeline.ts';
import ScorePlaybackPlan from '../domain/performance/score-playback-plan.ts';
import { focusAdjacentTimelineNote, selectFocusedNotePitch, type TimelineCursor } from './timeline-cursor.ts';

const columns = ['sign', 'tens', 'ones'] as const;
export type VelocityOffsetDraft = { offset: number; column: typeof columns[number] };
type Move = { action: 'move'; axis: 'note' | 'pitch'; direction: -1 | 1 };
type Result = { action: 'update'; draft: VelocityOffsetDraft } | { action: 'commit' | 'cancel' } | Move;

namespace VelocityOffsetInput {
  export function create(offset = 0): VelocityOffsetDraft {
    return { offset, column: 'ones' };
  }

  export function createRange(project: ScoreProject, selection: readonly LocatedTimelineNote[]) {
    const editable = selection.filter(({ note }) => !note.tieFrom && note.pitches.length > 0);
    if (!editable.length) return;
    const velocityAt = ScorePlaybackPlan.createAttackVelocityLookup(project);
    const firstVelocity = velocityAt(editable[0], 0);
    const uniform = editable.every(entry => entry.note.pitches.every((_, index) => velocityAt(entry, index) === firstVelocity));
    return {
      noteIds: new Set(editable.map(({ note }) => note.id)),
      unadjusted: uniform ? firstVelocity : null,
      draft: create(),
    };
  }

  export function move(project: ScoreProject, cursor: TimelineCursor, { axis, direction }: Move): TimelineCursor {
    if (axis === 'pitch') return cursor.focusedGraceId ? cursor : selectFocusedNotePitch(project, cursor, direction);
    const next = focusAdjacentTimelineNote(project.outline, cursor, direction, note => !note.tieFrom);
    return next === cursor ? cursor : { ...next, focusedGraceId: null };
  }

  export function control(draft: VelocityOffsetDraft, event: KeyboardEvent, navigate = false): Result | undefined {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const { key } = event;
    if (key === 'Enter' || key.toLowerCase() === 'v') {
      if (!event.repeat) return { action: 'commit' };
      return;
    }
    if (key === 'Escape') return { action: 'cancel' };
    if (key === 'Delete') return { action: 'update', draft: { ...draft, offset: 0 } };
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const direction = key === 'ArrowLeft' ? -1 : 1;
      if (navigate) return { action: 'move', axis: 'note', direction };
      const index = columns.indexOf(draft.column) + direction;
      const column = columns[Math.max(0, Math.min(columns.length - 1, index))];
      return { action: 'update', draft: { ...draft, column } };
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const direction = key === 'ArrowUp' ? 1 : -1;
      if (navigate) return { action: 'move', axis: 'pitch', direction };
      const offset = draft.column === 'sign' ? direction * Math.abs(draft.offset)
        : draft.offset + direction * (draft.column === 'tens' ? 10 : 1);
      return { action: 'update', draft: { ...draft, offset: Math.max(-maxVelocityOffset, Math.min(maxVelocityOffset, offset)) || 0 } };
    }
  }
}
export default VelocityOffsetInput;
