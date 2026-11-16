import ScoreTimeline from './score-timeline.ts';
import ScoreNotes from './score-notes.ts';
import type { PianoNote, PianoPitch, PianoStaffName, ScoreProject } from './types.ts';

namespace TieFingerings {
  export function strip(pitch: PianoPitch): PianoPitch {
    const { fingering: _finger, substitutionFingering: _substitution, ...rest } = pitch;
    return rest;
  }

  /** Interpret legacy duplicates without changing the score. Different explicit
   * fingers or a substitution owned only by a continuation remain conflicts. */
  export function read(notes: readonly PianoNote[]) {
    const head = notes[0];
    const conflicts: number[] = [];
    const pitches = (head?.pitches ?? []).map((pitch, index) => {
      const members = notes.flatMap(note => note.pitches.filter(p => p.midi === pitch.midi));
      const fingers = [...new Set(members.flatMap(p => p.fingering === undefined ? [] : [p.fingering]))];
      if (fingers.length > 1 || members.some(p => p.substitutionFingering !== undefined && p.substitutionFingering !== pitch.substitutionFingering)) {
        conflicts.push(index); return pitch;
      }
      return pitch.fingering === undefined && fingers.length === 1 ? { ...pitch, fingering: fingers[0] } : pitch;
    });
    pitches.forEach((pitch, index) => {
      if (pitch.fingering !== undefined && pitches.some((other, i) => i !== index && other.fingering === pitch.fingering)) conflicts.push(index);
    });
    return { pitches, conflicts: [...new Set(conflicts)] };
  }

  export function resolve(project: ScoreProject, noteId: string, staff: PianoStaffName) {
    const chain = ScoreTimeline.tieChain(project.outline, noteId, staff);
    const head = chain[0];
    if (!head) return undefined;
    const state = read(chain.map(entry => entry.note));
    return { ...state, chain, note: { ...head.note, pitches: state.pitches } };
  }

  /** Canonical storage: a single owner per held pitch. Conflicting legacy values
   * are retained for diagnosis/manual resolution, never silently discarded. */
  export function normalize(project: ScoreProject): ScoreProject {
    let result = project;
    for (const staff of ['upperStaff', 'lowerStaff'] as const) {
      const updates = new Map<string, PianoNote>();
      const entries = ScoreTimeline.allNotes(project.outline, staff);
      const byId = new Map(entries.map(entry => [entry.note.id, entry]));
      for (const { note } of entries) {
        if (note.tieFrom || !note.tieTo) continue;
        const chain = [byId.get(note.id)!], seen = new Set([note.id]);
        while (chain.at(-1)!.note.tieTo) {
          const next = byId.get(chain.at(-1)!.note.tieTo!);
          if (!next || next.note.tieFrom !== chain.at(-1)!.note.id || seen.has(next.note.id)) break;
          seen.add(next.note.id); chain.push(next);
        }
        if (chain.length < 2) continue;
        const state = read(chain.map(entry => entry.note));
        for (const [memberIndex, entry] of chain.entries()) {
          const pitches = entry.note.pitches.map(pitch => {
            const index = note.pitches.findIndex(p => p.midi === pitch.midi);
            if (index < 0 || state.conflicts.includes(index)) return pitch;
            const next = memberIndex === 0 ? state.pitches[index] : strip(pitch);
            return next.fingering === pitch.fingering && next.substitutionFingering === pitch.substitutionFingering ? pitch : next;
          });
          if (pitches.some((pitch, index) => pitch !== entry.note.pitches[index])) updates.set(entry.note.id, { ...entry.note, pitches });
        }
      }
      result = ScoreNotes.map(result, new Set(updates.keys()), note => updates.get(note.id)!, staff);
    }
    ScoreTimeline.inheritTiming(project.outline, result.outline);
    return result;
  }

  /** When a tie splits or its head is deleted, the new attack inherits the
   * original initial finger. A substitution stays with its original attack. */
  export function reconcile(before: ScoreProject, after: ScoreProject): ScoreProject {
    if (before === after) return before;
    let result = after;
    for (const staff of ['upperStaff', 'lowerStaff'] as const) {
      const updates = new Map<string, PianoNote>();
      const previousNotes = new Map(ScoreTimeline.allNotes(before.outline, staff).map(entry => [entry.note.id, entry.note]));
      for (const { note } of ScoreTimeline.allNotes(after.outline, staff)) {
        if (note.tieFrom) continue;
        const previous = previousNotes.get(note.id);
        if (!previous?.tieFrom) continue;
        const source = resolve(before, note.id, staff);
        if (!source || source.conflicts.length) continue;
        const pitches = note.pitches.map(pitch => {
          const inherited = source.pitches.find(p => p.midi === pitch.midi)?.fingering;
          return pitch.fingering === undefined && inherited !== undefined ? { ...pitch, fingering: inherited } : pitch;
        });
        if (pitches.some((pitch, index) => pitch !== note.pitches[index])) updates.set(note.id, { ...note, pitches });
      }
      result = ScoreNotes.map(result, new Set(updates.keys()), note => updates.get(note.id)!, staff);
    }
    return normalize(result);
  }
}
export default TieFingerings;
