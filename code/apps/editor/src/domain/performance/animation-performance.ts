import ScorePlaybackPlan, { keyHoldSeconds, type PlaybackPlan } from './score-playback-plan.ts';
import ScoreTimeline from '../score/score-timeline.ts';
import TieFingerings from '../score/tie-fingerings.ts';
import type { ScoreProject } from '../score/types.ts';
import type { Note } from '../motion/motion.ts';
import AnimationRange, { type AnimationRange as Range } from './animation-range.ts';

export const ANIMATION_LEAD_IN = 0.6;
const SUBSTITUTION_MARGIN_SECONDS = 0.18;
export type AnimationIssue = { message: string; noteId?: string; pitchIndex?: number };
export type AnimationPerformance = {
  playback: PlaybackPlan;
  notes: Note[];
  duration: number;
  origins: { noteId: string; pitchIndex: number; label: string; firstMeasure?: number; lastMeasure?: number }[];
};

/** A read-only conversion from the shared audio performance, optionally clipped
 * to complete selected measures without losing inherited score context. */
export function inspectAnimation(project: ScoreProject, range: Range | null = null) {
  const resolved = range ? AnimationRange.resolve(project, range) : undefined;
  if (range && !resolved) {
    const playback: PlaybackPlan = { startPosition: 0, endPosition: 0, durationSeconds: 0, pedalInitiallyDown: false, pedalEvents: [], events: [] };
    return { scopeLabel: 'Selected measures unavailable', attacks: 0, assigned: 0,
      issues: [{ message: 'The selected measure range no longer exists. Select the measures and reopen Hand Animation.' }] as AnimationIssue[],
      performance: { playback, notes: [], origins: [], duration: 0 } as AnimationPerformance };
  }
  const prepared = ScorePlaybackPlan.prepare(project), fullPlayback = prepared.create(0);
  const clipped = resolved ? AnimationRange.clip(fullPlayback, resolved, prepared.clock) : undefined;
  const playback = clipped?.playback ?? fullPlayback, offset = clipped?.startSeconds ?? 0;
  const originalEvents = new Map(fullPlayback.events.map(event => [event.sourceNoteId, event]));
  const handAttacks = { left: [] as number[], right: [] as number[] };
  for (const event of fullPlayback.events) {
    for (const source of event.performance ?? []) {
      const times = handAttacks[source.hand];
      if (times.at(-1) !== event.startSeconds) times.push(event.startSeconds);
    }
  }
  const relevant = new Set(playback.events.flatMap(event =>
    event.performance?.filter((_, index) => keyHoldSeconds(event, index) > 0).map(source => source.noteId) ?? []));
  const measures = project.outline.filter(block => block.type === 'measure');
  const measureNumbers = new Map(measures.map((measure, index) => [measure.id, index + 1]));
  const locations = new Map<string, { label: string; measure: number }>();
  const issues: AnimationIssue[] = [];
  for (const staff of ['upperStaff', 'lowerStaff'] as const) {
    const count = Math.max(0, ...measures.map(measure => measure.data[staff].voices.length));
    for (let voice = 0; voice < count; voice++) for (const entry of ScoreTimeline.notes(project.outline, staff, voice)) {
      const measure = measureNumbers.get(entry.measure.id)!;
      const label = `Measure ${measure}, ${staff === 'upperStaff' ? 'right' : 'left'} hand, voice ${voice + 1}`;
      locations.set(entry.note.id, { label, measure });
      for (const grace of entry.note.beforeGraceNotes ?? []) locations.set(grace.id, { label: `${label}, grace note`, measure });
      // Resolve the same owner/legacy conflicts as editing and automatic fingering.
      if (relevant.has(entry.note.id) && !entry.note.tieFrom && entry.note.tieTo) {
        const state = TieFingerings.resolve(project, entry.note.id, staff)!;
        for (const pitchIndex of state.conflicts)
          issues.push({ message: `${label}, MIDI ${entry.note.pitches[pitchIndex].midi}: conflicting finger changes inside a tie are not supported. Resolve the finger on the first tied note.`, noteId: entry.note.id, pitchIndex });
      }
    }
  }
  const notes: Note[] = [], origins: AnimationPerformance['origins'] = [];
  let attacks = 0, assigned = 0;
  for (const event of playback.events) event.pitches.forEach((midiNote, index) => {
    const duration = keyHoldSeconds(event, index);
    if (duration <= 0) return;
    attacks++;
    const source = event.performance?.[index];
    const location = locations.get(source?.noteId ?? '');
    const label = `${location?.label ?? 'Score'}, MIDI ${midiNote}`;
    if (!source || source.fingering === undefined) {
      issues.push({ message: `${label}: fingering is missing.`, noteId: source?.noteId, pitchIndex: source?.pitchIndex });
      return;
    }
    assigned++;
    const add = (note: Note) => {
      const start = note.time - ANIMATION_LEAD_IN, end = start + note.duration;
      // A tie can be owned by an attack outside the selected range. Use the
      // notation segments actually covered by this contact for progress.
      const covered = event.notationRanges?.filter(part =>
        part.startSeconds < end - 1e-9 && (part.endSeconds ?? Infinity) > start + 1e-9)
        .flatMap(part => locations.get(part.noteId)?.measure ?? []);
      const firstMeasure = covered?.length ? Math.min(...covered) : location?.measure;
      const lastMeasure = covered?.length ? Math.max(...covered) : firstMeasure;
      notes.push(note);
      origins.push({ noteId: source.noteId, pitchIndex: source.pitchIndex, label, firstMeasure, lastMeasure });
    };
    const note: Note = { time: event.startSeconds + ANIMATION_LEAD_IN, duration, midiNote,
      hand: source.hand, finger: source.fingering, voice: source.voice };
    if (source.substitutionFingering === undefined) add(note);
    else {
      // Prefer the midpoint unless the hand has another attack before then.
      // Use the space before that attack when there is time to depress,
      // transfer and release the original finger.
      const original = originalEvents.get(event.sourceNoteId)!;
      const originalIndex = original.pitches.indexOf(midiNote);
      const originalDuration = keyHoldSeconds(original, originalIndex);
      const midpoint = original.startSeconds + originalDuration / 2;
      const next = handAttacks[source.hand].find(time => time > original.startSeconds + 1e-8);
      const beforeNext = next !== undefined && next < midpoint &&
        next - original.startSeconds >= 2 * SUBSTITUTION_MARGIN_SECONDS;
      const handoffTime = beforeNext ? (original.startSeconds + next) / 2 : midpoint;
      const handoff = handoffTime - offset + ANIMATION_LEAD_IN;
      const end = note.time + duration;
      if (handoff <= note.time) add({ ...note, finger: source.substitutionFingering });
      else if (handoff >= end) add(note);
      else {
        const overlap = Math.min(0.04, originalDuration * 0.1, (end - handoff) / 2);
        add({ ...note, duration: handoff - note.time + overlap });
        add({ ...note, time: handoff, duration: end - handoff,
          finger: source.substitutionFingering, action: 'substitute' });
      }
    }
  });
  if (!attacks) issues.push({ message: range ? 'The selected measures have no notes to animate.' : 'The score has no notes to animate.' });
  const performance: AnimationPerformance = { playback, notes, origins,
    duration: ANIMATION_LEAD_IN + playback.durationSeconds + 0.62 };
  return { performance, issues, attacks, assigned,
    scopeLabel: resolved ? `Measures ${resolved.firstMeasure}–${resolved.lastMeasure}` : 'Full score' };
}

/** Audio shares motion's lead-in and keeps pedal sustain separate from key hold. */
export function animationAudio(performance: AnimationPerformance): PlaybackPlan {
  return { ...performance.playback, durationSeconds: performance.duration,
    events: performance.playback.events.map(event => ({ ...event, startSeconds: event.startSeconds + ANIMATION_LEAD_IN,
      ...(event.rollAnchorSeconds !== undefined ? { rollAnchorSeconds: event.rollAnchorSeconds + ANIMATION_LEAD_IN } : {}) })),
    pedalEvents: performance.playback.pedalEvents.map(event => ({ ...event, atSeconds: event.atSeconds + ANIMATION_LEAD_IN })) };
}
