import type { PianoFingering, PianoNote, PianoStaffName, ScoreProject } from './types.ts';
import TieFingerings from './tie-fingerings.ts';
import ScoreGlissando from './score-glissando.ts';

export type FingeringRules = {
  usedFingerings: ReadonlySet<PianoFingering>;
  allowSubstitution: boolean;
};

namespace ScoreFingerings {
  export function isAssignable(project: ScoreProject, noteId: string) {
    return !ScoreGlissando.fingeringNotes(project).has(noteId);
  }

  export function owner(project: ScoreProject, noteId: string, staff: PianoStaffName) {
    return isAssignable(project, noteId) ? TieFingerings.resolve(project, noteId, staff)?.note : undefined;
  }
  /** Only the initial finger reserves a finger on related pitches. Exclude the edited pitch. */
  export function rules(note: PianoNote, pitchIndex: number, graceNoteId?: string): FingeringRules {
    const usedFingerings = new Set<PianoFingering>();
    for (const [index, pitch] of note.pitches.entries()) {
      if (graceNoteId === undefined && index === pitchIndex) continue;
      if (pitch.fingering !== undefined) usedFingerings.add(pitch.fingering);
    }
    for (const grace of note.beforeGraceNotes ?? []) for (const [index, pitch] of grace.pitches.entries()) {
      if (grace.id === graceNoteId && index === pitchIndex) continue;
      if (pitch.fingering !== undefined) usedFingerings.add(pitch.fingering);
    }
    return { usedFingerings, allowSubstitution: graceNoteId === undefined };
  }

  export function allows(rules: FingeringRules, fingering: PianoFingering, substitutionFingering?: PianoFingering): boolean {
    return !rules.usedFingerings.has(fingering) && (substitutionFingering === undefined ||
      rules.allowSubstitution && substitutionFingering !== fingering && !rules.usedFingerings.has(substitutionFingering));
  }
}

export default ScoreFingerings;
