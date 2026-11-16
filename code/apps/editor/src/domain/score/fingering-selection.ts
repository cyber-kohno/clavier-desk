import ScoreTimeline, { type LocatedTimelineNote } from './score-timeline.ts';
import ScoreNotes from './score-notes.ts';
import ScoreVoice from './score-voice.ts';
import TieFingerings from './tie-fingerings.ts';
import type { PianoFingering, PianoNote, PianoPitch, PianoStaffName, ScoreProject } from './types.ts';

export type FingeringSelection = { staff: PianoStaffName; noteIds: readonly string[] };
export type FingeringAssignment = { noteId: string; pitchIndex: number; finger: PianoFingering };
export type FingeringIssue = { message: string; noteId?: string; pitchIndex?: number };

namespace FingeringSelection {
  export function inspect(project: ScoreProject, selection: FingeringSelection) {
    const ids = new Set(selection.noteIds);
    const entries = ScoreTimeline.allNotes(project.outline, selection.staff).filter(entry => ids.has(entry.note.id))
      .sort((a, b) => a.measureStartSixteenths + a.positionSixteenths - b.measureStartSixteenths - b.positionSixteenths);
    const issues: FingeringIssue[] = [];
    const first = entries[0], last = entries.at(-1);
    if (!first || entries.length !== ids.size) issues.push({ message: 'Select existing notes in one staff and voice.' });
    else if (entries.some(entry => entry.voiceIndex !== first.voiceIndex)) issues.push({ message: 'Select notes in one voice.' });
    else {
      const sequence = ScoreTimeline.notes(project.outline, selection.staff, first.voiceIndex);
      if (sequence.slice(sequence.findIndex(entry => entry.note.id === first.note.id), sequence.findIndex(entry => entry.note.id === last!.note.id) + 1).some(entry => !ids.has(entry.note.id)))
        issues.push({ message: 'Select a continuous range of notes. Rests between notes are allowed.' });
    }
    const trills = new Set((project.trills ?? []).flatMap(trill => {
      const chain = ScoreTimeline.tieChain(project.outline, trill.startNoteId, selection.staff);
      return chain.filter(entry => ids.has(entry.note.id)).map(entry => entry.note.id);
    }));
    for (const entry of entries) {
      const { note } = entry;
      const issue = (message: string, pitchIndex?: number) => issues.push({ message: `${label(project, entry, selection.staff)}: ${message}`, noteId: note.id, pitchIndex });
      if (note.beforeGraceNotes?.length) issue('Grace notes are not supported by Auto Assign yet.');
      if (trills.has(note.id)) issue('Trills are not supported by Auto Assign yet.');
      if (note.arpeggio) issue('Rolled chords are not supported by Auto Assign yet.');
      if (note.pitches.some(pitch => pitch.substitutionFingering !== undefined)) issue('Held-note finger substitutions are not supported by Auto Assign yet.');
      if (!note.pitches.length || note.pitches.length > 5) issue('A chord must contain between one and five pitches.');
      if (note.tieFrom && !ids.has(note.tieFrom) || note.tieTo && !ids.has(note.tieTo))
        issue('Include the entire tie chain in the selection.');
      const seen = new Set<number>();
      note.pitches.forEach((pitch, index) => {
        if (pitch.fingering !== undefined && seen.has(pitch.fingering)) issue(`Finger ${pitch.fingering} is fixed to more than one chord pitch.`, index);
        if (pitch.fingering !== undefined) seen.add(pitch.fingering);
      });
    }
    const attacks = entries.filter(entry => !entry.note.tieFrom).map(entry => {
      const state = entry.note.tieTo ? TieFingerings.resolve(project, entry.note.id, selection.staff)!
        : { note: entry.note, conflicts: [] };
      for (const index of state.conflicts) issues.push({ message: `${label(project, entry, selection.staff)}, MIDI ${entry.note.pitches[index].midi}: conflicting fingerings inside a tie. Resolve the fixed fingers before Auto Assign.`, noteId: entry.note.id, pitchIndex: index });
      return { ...entry, note: state.note };
    });
    const total = attacks.reduce((sum, entry) => sum + entry.note.pitches.length, 0);
    const fixed = attacks.reduce((sum, entry) => sum + entry.note.pitches.filter(pitch => pitch.fingering !== undefined).length, 0);
    const measures = project.outline.filter(block => block.type === 'measure');
    return { entries, attacks, issues, total, fixed, missing: total - fixed, voiceIndex: first?.voiceIndex ?? 0,
      firstMeasure: first ? measures.indexOf(first.measure) + 1 : 0, lastMeasure: last ? measures.indexOf(last.measure) + 1 : 0 };
  }

  export function label(project: ScoreProject, entry: LocatedTimelineNote, staff: PianoStaffName) {
    const local = ScoreVoice.flatten(entry.measure.data[staff].voices[entry.voiceIndex], entry.measure.data.length)
      .filter(item => item.element.kind === 'note').findIndex(item => item.element.id === entry.note.id) + 1;
    return `Measure ${project.outline.filter(block => block.type === 'measure').indexOf(entry.measure) + 1}, voice ${entry.voiceIndex + 1}, note ${local}`;
  }

  /** Do not delete a trill's shared sequence when any part of its span is outside the selection. */
  export function clearAvailability(project: ScoreProject, selection: FingeringSelection) {
    const ids = new Set(selection.noteIds);
    const entries = ScoreTimeline.allNotes(project.outline, selection.staff).filter(entry => ids.has(entry.note.id));
    if (!ids.size || entries.length !== ids.size) return { allowed: false, reason: 'Select existing notes.' };
    for (const { note } of entries) if (note.tieFrom || note.tieTo) {
      if (ScoreTimeline.tieChain(project.outline, note.id, selection.staff).some(entry => !ids.has(entry.note.id)))
        return { allowed: false, reason: 'Select the entire tie chain to clear its fingering.' };
    }
    for (const trill of project.trills ?? []) {
      if (!trill.settings.fingerings) continue;
      const chain = ScoreTimeline.tieChain(project.outline, trill.startNoteId, selection.staff);
      if (chain.some(entry => ids.has(entry.note.id)) && chain.some(entry => !ids.has(entry.note.id)))
        return { allowed: false, reason: 'Select the entire trill span to clear its fingering sequence.' };
    }
    const hasFingers = entries.some(({ note }) => [...note.pitches, ...(note.beforeGraceNotes ?? []).flatMap(grace => grace.pitches)]
      .some(pitch => pitch.fingering !== undefined || pitch.substitutionFingering !== undefined)) ||
      (project.trills ?? []).some(trill => ids.has(trill.startNoteId) && trill.settings.fingerings !== undefined);
    return { allowed: hasFingers, reason: hasFingers ? '' : 'The selection has no fingerings to clear.' };
  }

  export function clear(project: ScoreProject, selection: FingeringSelection): ScoreProject {
    if (!clearAvailability(project, selection).allowed) return project;
    const strip = (pitch: PianoPitch): PianoPitch => {
      if (pitch.fingering === undefined && pitch.substitutionFingering === undefined) return pitch;
      const { fingering: _finger, substitutionFingering: _substitution, ...rest } = pitch;
      return rest;
    };
    const next = ScoreNotes.map(project, new Set(selection.noteIds), note => ({ ...note, pitches: note.pitches.map(strip),
      ...(note.beforeGraceNotes ? { beforeGraceNotes: note.beforeGraceNotes.map(grace => ({ ...grace, pitches: grace.pitches.map(strip) })) } : {}) }), selection.staff);
    const ids = new Set(selection.noteIds);
    const trills = next.trills?.map(trill => {
      if (!ids.has(trill.startNoteId) || trill.settings.fingerings === undefined) return trill;
      const { fingerings: _fingerings, ...settings } = trill.settings;
      return { ...trill, settings };
    });
    const result = trills ? { ...next, trills } : next;
    ScoreTimeline.inheritTiming(project.outline, result.outline);
    return result;
  }

  /** Atomic fill only: reject incomplete, duplicate, stale or anchor-changing drafts. */
  export function apply(project: ScoreProject, selection: FingeringSelection, assignments: readonly FingeringAssignment[]): ScoreProject {
    const inspection = inspect(project, selection);
    if (inspection.issues.length || !inspection.missing) return project;
    const notes = new Map(inspection.attacks.map(entry => [entry.note.id, entry.note]));
    const changes = new Map<string, Map<number, PianoFingering>>();
    for (const assignment of assignments) {
      const pitch = notes.get(assignment.noteId)?.pitches[assignment.pitchIndex];
      if (!pitch || !Number.isInteger(assignment.pitchIndex) || !Number.isInteger(assignment.finger) || assignment.finger < 1 || assignment.finger > 5 ||
        pitch.fingering !== undefined || changes.get(assignment.noteId)?.has(assignment.pitchIndex)) return project;
      const pitches = changes.get(assignment.noteId) ?? new Map();
      pitches.set(assignment.pitchIndex, assignment.finger); changes.set(assignment.noteId, pitches);
    }
    if (assignments.length !== inspection.missing) return project;
    const updated = new Map<string, PianoNote>();
    for (const [id, note] of notes) {
      const pitches = note.pitches.map((pitch, index) => changes.get(id)?.has(index) ? { ...pitch, fingering: changes.get(id)!.get(index)! } : pitch);
      if (new Set(pitches.map(pitch => pitch.fingering)).size !== pitches.length) return project;
      updated.set(id, changes.has(id) ? { ...note, pitches } : note);
    }
    const result = TieFingerings.normalize(ScoreNotes.map(project, new Set(selection.noteIds), note => updated.get(note.id) ?? note, selection.staff));
    ScoreTimeline.inheritTiming(project.outline, result.outline);
    return result;
  }
}
export default FingeringSelection;
