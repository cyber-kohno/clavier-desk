import ScoreTimeline from '../domain/score/score-timeline.ts';
import MusicalTime from '../domain/theory/musical-time.ts';
import WrittenValue from '../domain/theory/written-value.ts';
import type { NoteValue, ScoreProject } from '../domain/score/types.ts';
import { resolveTimelineNumberInput } from './number-input.ts';
import { TIMELINE_CURSOR_UNITS } from './timeline-cursor.ts';

export type HairpinCursor = { position: number; value: NoteValue };

namespace HairpinInput {
  export function navigate(outline: ScoreProject['outline'], cursor: HairpinCursor, event: KeyboardEvent): HairpinCursor {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const step = WrittenValue.sixteenths(cursor.value) * (event.key === 'ArrowLeft' ? -1 : 1);
      return { ...cursor, position: Math.max(0, Math.min(ScoreTimeline.index(outline).length, MusicalTime.addNumbers(cursor.position, step))) };
    }
    const number = resolveTimelineNumberInput(event, false);
    const unit = TIMELINE_CURSOR_UNITS.find(unit => unit.key === number?.key);
    return unit ? { ...cursor, value: { type: unit.type, dots: 0 } } : cursor;
  }
}

export default HairpinInput;
