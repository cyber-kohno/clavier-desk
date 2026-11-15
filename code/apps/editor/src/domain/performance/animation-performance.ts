import ScorePlaybackPlan, { type PlaybackPlan } from './score-playback-plan.ts';
import ScoreTimeline from '../score/score-timeline.ts';
import type { ScoreProject } from '../score/types.ts';
import type { Note } from '../motion/motion.ts';

export const ANIMATION_LEAD_IN = 0.6;
export type AnimationIssue = { message: string; noteId?: string; pitchIndex?: number };
export type AnimationPerformance = {
  playback: PlaybackPlan;
  notes: Note[];
  duration: number;
  origins: { noteId: string; pitchIndex: number; label: string }[];
};

/** A read-only conversion from the same full-score performance used by audio. */
export function inspectAnimation(project: ScoreProject) {
  const playback = ScorePlaybackPlan.create(project, 0);
  const measures = project.outline.filter(block => block.type === 'measure');
  const locations = new Map<string, string>();
  const issues: AnimationIssue[] = [];
  for (const staff of ['upperStaff', 'lowerStaff'] as const) {
    const count = Math.max(0, ...measures.map(measure => measure.data[staff].voices.length));
    for (let voice = 0; voice < count; voice++) for (const entry of ScoreTimeline.notes(project.outline, staff, voice)) {
      const label = `Measure ${measures.indexOf(entry.measure) + 1}, ${staff === 'upperStaff' ? 'right' : 'left'} hand, voice ${voice + 1}`;
      locations.set(entry.note.id, label);
      for (const grace of entry.note.beforeGraceNotes ?? []) locations.set(grace.id, `${label}, grace note`);
      // A tie is one held contact. An explicitly different continuation needs a
      // timed substitution, which the current notation does not describe.
      if (entry.note.tieFrom) {
        let head = entry.note;
        const visited = new Set<string>();
        while (head.tieFrom && !visited.has(head.id)) {
          visited.add(head.id);
          const previous = ScoreTimeline.note(project.outline, head.tieFrom, staff)?.note;
          if (!previous) break;
          head = previous;
        }
        entry.note.pitches.forEach((pitch, pitchIndex) => {
          const prior = head.pitches.find(p => p.midi === pitch.midi);
          if (pitch.substitutionFingering !== undefined || (pitch.fingering !== undefined && prior?.fingering !== undefined && pitch.fingering !== prior.fingering))
            issues.push({ message: `${label}, MIDI ${pitch.midi}: finger changes inside a tie are not supported. Set substitution on the first tied note.`, noteId: entry.note.id, pitchIndex });
        });
      }
    }
  }
  const notes: Note[] = [], origins: AnimationPerformance['origins'] = [];
  let attacks = 0, assigned = 0;
  const add = (note: Note, origin: AnimationPerformance['origins'][number]) => { notes.push(note); origins.push(origin); };
  for (const event of playback.events) event.pitches.forEach((midiNote, index) => {
    attacks++;
    const source = event.performance?.[index];
    const label = `${locations.get(source?.noteId ?? '') ?? 'Score'}, MIDI ${midiNote}`;
    if (!source || source.fingering === undefined) {
      issues.push({ message: `${label}: fingering is missing.`, noteId: source?.noteId, pitchIndex: source?.pitchIndex });
      return;
    }
    assigned++;
    const origin = { noteId: source.noteId, pitchIndex: source.pitchIndex, label };
    const duration = event.pitchDurationsSeconds?.[index] ?? event.durationSeconds;
    const note: Note = { time: event.startSeconds + ANIMATION_LEAD_IN, duration, midiNote,
      hand: source.hand, finger: source.fingering, voice: source.voice };
    if (source.substitutionFingering === undefined) add(note, origin);
    else {
      // Deterministic default: receive halfway through the held note, with a
      // short overlap. Audio remains one uninterrupted note.
      const handoff = duration / 2, overlap = Math.min(0.04, duration * 0.1);
      add({ ...note, duration: handoff + overlap }, origin);
      add({ ...note, time: note.time + handoff, duration: duration - handoff,
        finger: source.substitutionFingering, action: 'substitute' }, origin);
    }
  });
  if (!attacks) issues.push({ message: 'The score has no notes to animate.' });
  const performance: AnimationPerformance = { playback, notes, origins,
    duration: ANIMATION_LEAD_IN + playback.durationSeconds + 0.62 };
  return { performance, issues, attacks, assigned };
}

/** Audio shares motion's lead-in and keeps pedal sustain separate from key hold. */
export function animationAudio(performance: AnimationPerformance): PlaybackPlan {
  return { ...performance.playback, durationSeconds: performance.duration,
    events: performance.playback.events.map(event => ({ ...event, startSeconds: event.startSeconds + ANIMATION_LEAD_IN })),
    pedalEvents: performance.playback.pedalEvents.map(event => ({ ...event, atSeconds: event.atSeconds + ANIMATION_LEAD_IN })) };
}
