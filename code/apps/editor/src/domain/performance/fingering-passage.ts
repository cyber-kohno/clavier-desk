import FingeringSelection, { type FingeringSelection as Selection, type FingeringIssue } from '../score/fingering-selection.ts';
import ScorePlaybackPlan, { keyHoldSeconds } from './score-playback-plan.ts';
import type { PianoFingering, ScoreProject } from '../score/types.ts';

export type FingeringTarget = { noteId: string; graceNoteId?: string; pitchIndex: number; fixed?: PianoFingering };
export type FingeringAttack = { onsetTime?: number; midi: number; duration: number; fixed?: PianoFingering; targets: FingeringTarget[] };
export type FingeringStep = { time: number; attacks: FingeringAttack[]; label: string };
export type FingeringPassage = { hand: 'left' | 'right'; steps: FingeringStep[]; missing: number };

namespace FingeringPassage {
  /** Use the shared performance clock for the complete expanded hand passage. */
  export function prepare(project: ScoreProject, selection: Selection): { passage?: FingeringPassage; issues: FingeringIssue[] } {
    const inspection = FingeringSelection.inspect(project, selection);
    if (inspection.issues.length) return { issues: inspection.issues };
    const { entries } = inspection;
    // A tie is one attack and one assignment target. Legacy continuation
    // anchors are interpreted by inspection, but results belong to the head.
    const byId = new Map(entries.map(entry => [entry.note.id, entry]));
    const performanceById = new Map(inspection.performanceAttacks.map(entry => [entry.note.id, entry]));
    const targets = new Map<string, Map<number, FingeringTarget[]>>();
    for (const entry of inspection.performanceAttacks) {
      const pitches = new Map<number, FingeringTarget[]>();
      entry.note.pitches.forEach((pitch, pitchIndex) => {
        pitches.set(pitch.midi, [{ noteId: entry.noteId, ...(entry.graceNoteId ? { graceNoteId: entry.graceNoteId } : {}), pitchIndex, fixed: pitch.fingering }]);
      });
      targets.set(entry.note.id, pitches);
    }
    const events = ScorePlaybackPlan.create(project, 0).events.filter(event => event.performance?.some(identity => performanceById.has(identity.noteId) && identity.hand === (selection.staff === "upperStaff" ? "right" : "left")));
    const offset = events[0]?.startSeconds ?? 0;
    const steps: FingeringStep[] = [];
    for (const event of events) {
      const identity = event.performance?.[0];
      const source = identity ? performanceById.get(identity.noteId) : undefined;
      const entry = source ? byId.get(source.noteId) : undefined;
      if (!entry) return { issues: [{ message: 'Could not resolve a selected performance event.' }] };
      const attacks: FingeringAttack[] = [];
      for (const [index, midi] of event.pitches.entries()) {
        const list = targets.get(source!.note.id)?.get(midi);
        if (!list?.length) return { issues: [{ message: 'Could not resolve a selected pitch.', noteId: entry.note.id }] };
        const fixed = [...new Set(list.flatMap(target => target.fixed === undefined ? [] : [target.fixed]))];
        if (fixed.length > 1) return { issues: [{ message: `${FingeringSelection.label(project, entry, selection.staff)}, MIDI ${midi}: fixed fingers disagree within a tie.`, noteId: entry.note.id }] };
        attacks.push({ midi, fixed: fixed[0], duration: keyHoldSeconds(event, index), targets: list });
      }
      steps.push({ time: event.startSeconds - offset + 0.6, attacks, label: FingeringSelection.label(project, entry, selection.staff) + (source?.graceNoteId ? ', grace ' + source.graceIndex : '') });
    }
    // Each onset considers all contacts still held by this hand, across voices.
    const timeline: FingeringStep[] = [];
    const contacts = steps.flatMap(step => step.attacks.map(attack => ({ ...attack, onsetTime: step.time })));
    for (const time of [...new Set(steps.map(step => step.time))].sort((a,b) => a-b)) {
      const active = contacts.filter(attack => attack.onsetTime <= time + 1e-8 && attack.onsetTime + attack.duration > time + 1e-8)
        .map(attack => ({ ...attack, duration: attack.onsetTime + attack.duration - time }));
      timeline.push({ time, attacks: active, label: steps.find(step => Math.abs(step.time-time)<1e-8)!.label });
    }
    if (!steps.length) return { issues: [{ message: 'The selection contains no supported attacks.' }] };
    return { passage: { hand: selection.staff === 'upperStaff' ? 'right' : 'left', steps: timeline, missing: inspection.missing }, issues: [] };
  }
}
export default FingeringPassage;
