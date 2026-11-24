import ScoreTimeline from '../score/score-timeline.ts';
import type { ScoreProject } from '../score/types.ts';
import { keyHoldSeconds, type PlaybackPlan } from './score-playback-plan.ts';

export type AnimationRange = { firstMeasureId: string; lastMeasureId: string };
export type ResolvedAnimationRange = { startPosition: number; endPosition: number; firstMeasure: number; lastMeasure: number; noteIds: ReadonlySet<string> };

namespace AnimationRange {
  export function key(range?: AnimationRange | null) {
    return range ? JSON.stringify([range.firstMeasureId, range.lastMeasureId]) : 'full';
  }

  export function resolve(project: ScoreProject, range: AnimationRange): ResolvedAnimationRange | undefined {
    const measures = project.outline.filter(block => block.type === 'measure');
    const first = measures.findIndex(measure => measure.id === range.firstMeasureId);
    const last = measures.findIndex(measure => measure.id === range.lastMeasureId);
    if (first < 0 || last < first) return undefined;
    const startPosition = ScoreTimeline.outlinePosition(project.outline, measures[first].id);
    const endPosition = ScoreTimeline.outlinePosition(project.outline, measures[last].id) + measures[last].data.length.cnt / measures[last].data.length.unit * 16;
    const selected = new Set(measures.slice(first, last + 1).map(measure => measure.id));
    const noteIds = new Set<string>();
    for (const staff of ['upperStaff', 'lowerStaff'] as const) for (const entry of ScoreTimeline.allNotes(project.outline, staff)) {
      if (!selected.has(entry.measure.id)) continue;
      noteIds.add(entry.note.id);
      for (const grace of entry.note.beforeGraceNotes ?? []) noteIds.add(grace.id);
    }
    return { startPosition, endPosition, firstMeasure: first + 1, lastMeasure: last + 1, noteIds };
  }

  /** Keep score context, but include only attacks owned by selected notation
   * (including ties entering the range), rather than outside slur-release tails. */
  export function clip(plan: PlaybackPlan, range: ResolvedAnimationRange, clock: { secondsAt(position: number): number }) {
    const boundaryStart = clock.secondsAt(range.startPosition), end = clock.secondsAt(range.endPosition);
    const belongs = (event: PlaybackPlan['events'][number]) => (event.notationNoteIds ?? [event.sourceNoteId]).some(id => range.noteIds.has(id));
    // Include selected-note grace/arpeggio pre-roll, but never expand back to an
    // incoming tie's original attack outside the selected notation.
    const start = Math.min(boundaryStart, ...plan.events.filter(event => belongs(event) && event.startSeconds < boundaryStart &&
      event.performance?.some(source => range.noteIds.has(source.noteId))).map(event => event.startSeconds));
    const durationSeconds = end - start;
    const events: PlaybackPlan['events'] = [];
    for (const event of plan.events) {
      if (!belongs(event)) continue;
      const onset = Math.max(start, event.startSeconds);
      if (onset >= end) continue;
      const pitches: number[] = [], durations: number[] = [], indices: number[] = [];
      event.pitches.forEach((pitch, index) => {
        const stop = Math.min(end, event.startSeconds + (event.pitchDurationsSeconds?.[index] ?? event.durationSeconds));
        if (stop <= onset) return;
        pitches.push(pitch); durations.push(stop - onset);
        indices.push(index);
      });
      if (!pitches.length) continue;
      const notationRanges = event.notationRanges?.filter(part => range.noteIds.has(part.noteId)).map(part => ({
        ...part, startSeconds: Math.max(start, part.startSeconds) - start,
        endSeconds: Math.min(end, part.endSeconds ?? end) - start,
      })).filter(part => part.endSeconds > part.startSeconds);
      events.push({ ...event, startSeconds: onset - start, durationSeconds: Math.max(...durations), pitches,
        ...(event.glissando ? { glissando: { ...event.glissando,
          attackSeconds: event.glissando.attackSeconds - start, nextSeconds: event.glissando.nextSeconds - start,
          sweepEndSeconds: Math.min(end, event.glissando.sweepEndSeconds) - start } } : {}),
        ...(event.rollAnchorSeconds !== undefined ? { rollAnchorSeconds: event.rollAnchorSeconds - start } : {}),
        pitchDurationsSeconds: durations, performance: event.performance ? indices.map(index => event.performance![index]) : undefined,
        ...(event.pitchVelocities ? { pitchVelocities: indices.map(index => event.pitchVelocities![index]) } : {}),
        keyHoldLimitsSeconds: event.keyHoldLimitsSeconds ? indices.map(index =>
          Math.max(0, Math.min(end, event.startSeconds + keyHoldSeconds(event, index)) - onset)) : undefined,
        notationNoteIds: event.notationNoteIds?.filter(id => range.noteIds.has(id)), notationRanges });
    }
    const preceding = plan.pedalEvents.filter(event => event.atSeconds < start).at(-1);
    const pedalInitiallyDown = preceding ? preceding.action !== 'stop' : plan.pedalInitiallyDown;
    const pedalEvents = plan.pedalEvents.filter(event => event.atSeconds >= start && event.atSeconds < end)
      .map(event => ({ ...event, atSeconds: event.atSeconds - start }));
    if ((pedalEvents.at(-1)?.action ?? (pedalInitiallyDown ? 'start' : 'stop')) !== 'stop')
      pedalEvents.push({ atSeconds: durationSeconds, action: 'stop' });
    return { startSeconds: start, playback: { startPosition: range.startPosition, endPosition: range.endPosition,
      durationSeconds, pedalInitiallyDown, pedalEvents, events } satisfies PlaybackPlan };
  }
}
export default AnimationRange;
