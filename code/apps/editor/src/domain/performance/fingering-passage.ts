import FingeringSelection, { type FingeringSelection as Selection, type FingeringIssue } from '../score/fingering-selection.ts';
import ScoreVoice from '../score/score-voice.ts';
import ScorePlaybackPlan from './score-playback-plan.ts';
import type { OutlineBlock, PianoFingering, ScoreProject } from '../score/types.ts';

export type FingeringTarget = { noteId: string; pitchIndex: number; fixed?: PianoFingering };
export type FingeringAttack = { midi: number; duration: number; fixed?: PianoFingering; targets: FingeringTarget[] };
export type FingeringStep = { time: number; attacks: FingeringAttack[]; label: string };
export type FingeringPassage = { hand: 'left' | 'right'; steps: FingeringStep[]; missing: number };

namespace FingeringPassage {
  /** Build playback from a detached score containing only selected notes. Neither
   * outside voices nor their articulations/fermatas/slurs can influence the search. */
  export function prepare(project: ScoreProject, selection: Selection): { passage?: FingeringPassage; issues: FingeringIssue[] } {
    const inspection = FingeringSelection.inspect(project, selection);
    if (inspection.issues.length) return { issues: inspection.issues };
    const { entries } = inspection, ids = new Set(selection.noteIds);
    const firstMeasure = project.outline.indexOf(entries[0].measure), lastMeasure = project.outline.indexOf(entries.at(-1)!.measure);
    const isolated: ScoreProject = { outline: [project.outline[0], { id: 'fingering-section', type: 'section', data: { name: '' } },
      ...project.outline.slice(firstMeasure, lastMeasure + 1).flatMap<OutlineBlock>(block => {
        if (block.type === 'key-change') return [block];
        if (block.type !== 'measure') return [];
        const empty = { voices: [{ id: 'fingering-empty', elements: [] }] };
        const voice = block.data[selection.staff].voices[inspection.voiceIndex];
        const selected = voice ? ScoreVoice.mapNotes(voice, note => ids.has(note.id) ? note : { id: note.id, kind: 'rest', value: note.value }) : empty.voices[0];
        return [{ ...block, data: { length: block.data.length, upperStaff: empty, lowerStaff: empty,
          [selection.staff]: { voices: [selected] } } }];
      })],
      tempoChanges: project.tempoChanges?.filter(change => ids.has(change.noteId)),
      slurs: project.slurs?.filter(slur => ids.has(slur.startNoteId) && ids.has(slur.endNoteId)),
    };
    // A tie is one attack and one assignment target. Legacy continuation
    // anchors are interpreted by inspection, but results belong to the head.
    const byId = new Map(entries.map(entry => [entry.note.id, entry]));
    const targets = new Map<string, Map<number, FingeringTarget[]>>();
    for (const entry of inspection.attacks) {
      const pitches = new Map<number, FingeringTarget[]>();
      entry.note.pitches.forEach((pitch, pitchIndex) => {
        pitches.set(pitch.midi, [{ noteId: entry.note.id, pitchIndex, fixed: pitch.fingering }]);
      });
      targets.set(entry.note.id, pitches);
    }
    const events = ScorePlaybackPlan.create(isolated, 0).events;
    const offset = events[0]?.startSeconds ?? 0;
    const steps: FingeringStep[] = [];
    for (const event of events) {
      const entry = byId.get(event.sourceNoteId);
      if (!entry) return { issues: [{ message: 'Could not resolve a selected performance event.' }] };
      const attacks: FingeringAttack[] = [];
      for (const [index, midi] of event.pitches.entries()) {
        const list = targets.get(entry.note.id)?.get(midi);
        if (!list?.length) return { issues: [{ message: 'Could not resolve a selected pitch.', noteId: entry.note.id }] };
        const fixed = [...new Set(list.flatMap(target => target.fixed === undefined ? [] : [target.fixed]))];
        if (fixed.length > 1) return { issues: [{ message: `${FingeringSelection.label(project, entry, selection.staff)}, MIDI ${midi}: fixed fingers disagree within a tie.`, noteId: entry.note.id }] };
        attacks.push({ midi, fixed: fixed[0], duration: event.pitchDurationsSeconds?.[index] ?? event.durationSeconds, targets: list });
      }
      steps.push({ time: event.startSeconds - offset + 0.6, attacks, label: FingeringSelection.label(project, entry, selection.staff) });
    }
    if (!steps.length) return { issues: [{ message: 'The selection contains no supported attacks.' }] };
    return { passage: { hand: selection.staff === 'upperStaff' ? 'right' : 'left', steps, missing: inspection.missing }, issues: [] };
  }
}
export default FingeringPassage;
