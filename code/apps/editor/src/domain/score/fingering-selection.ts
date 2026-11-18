import ScoreTimeline, { type LocatedTimelineNote } from './score-timeline.ts';
import ScoreNotes from './score-notes.ts';
import ScoreVoice from './score-voice.ts';
import ScoreArpeggio from './score-arpeggio.ts';
import TieFingerings from './tie-fingerings.ts';
import ScorePlaybackPlan, { keyHoldSeconds, type PlaybackEvent } from '../performance/score-playback-plan.ts';
import MusicalTime from '../theory/musical-time.ts';
import type { PianoFingering, PianoPitch, PianoStaffName, ScoreProject } from './types.ts';

export type FingeringSelection = { staff: PianoStaffName; noteIds: readonly string[] };
export type FingeringAssignment = { noteId: string; graceNoteId?: string; trillAttackIndex?: number; pitchIndex: number; finger: PianoFingering };
export type FingeringIssue = { message: string; noteId?: string; pitchIndex?: number };

namespace FingeringSelection {
  export function targetKey(noteId: string, graceNoteId?: string, trillAttackIndex?: number) {
    return JSON.stringify([noteId, graceNoteId ?? null, trillAttackIndex ?? null]);
  }
  const onset = (entry: LocatedTimelineNote) => MusicalTime.addNumbers(entry.measureStartSixteenths, entry.positionSixteenths);
  const release = (entry: LocatedTimelineNote) => MusicalTime.addNumbers(onset(entry), entry.lengthSixteenths);
  const byOnset = (a: LocatedTimelineNote, b: LocatedTimelineNote) => MusicalTime.compareNumbers(onset(a), onset(b)) || a.voiceIndex - b.voiceIndex;

  function seedScope(project: ScoreProject, selection: FingeringSelection) {
    const ids = new Set(selection.noteIds);
    const entries = (ScoreTimeline.isPrepared(project.outline)
      ? [...ids].flatMap(id => {
          const entry = ScoreTimeline.note(project.outline, id, selection.staff);
          return entry ? [entry] : [];
        })
      : ScoreTimeline.allNotes(project.outline, selection.staff).filter(entry => ids.has(entry.note.id))
    ).sort(byOnset);
    const issues: FingeringIssue[] = [];
    const first = entries[0], last = entries.at(-1);
    if (!first || entries.length !== ids.size) issues.push({ message: 'Select existing notes in one staff and voice.' });
    else if (entries.some(entry => entry.voiceIndex !== first.voiceIndex)) issues.push({ message: 'Select notes in one voice.' });
    else {
      const sequence = ScoreTimeline.notesInRange(project.outline, selection.staff, first.voiceIndex, onset(first), release(last!));
      if (sequence.some(entry => !ids.has(entry.note.id)))
        issues.push({ message: 'Select a continuous range of notes. Rests between notes are allowed.' });
    }
    return { entries, ids, issues, selectedCount: entries.length, first, last };
  }

  export function scope(project: ScoreProject, selection: FingeringSelection) {
    const seedScopeResult = seedScope(project, selection);
    let { entries } = seedScopeResult;
    const { ids, issues, first } = seedScopeResult;
    let events: PlaybackEvent[] = [];
    if (!issues.length) {
      const all = ScoreTimeline.allNotes(project.outline, selection.staff);
      const owners = new Map(all.flatMap(entry => [[entry.note.id, entry.note.id], ...(entry.note.beforeGraceNotes ?? []).map(grace => [grace.id, entry.note.id])]).map(pair => pair as [string, string]));
      const bounds = new Map<string, { start: number; end: number }>();
      const hand = selection.staff === 'upperStaff' ? 'right' : 'left';
      events = ScorePlaybackPlan.create(project, 0).events.filter(event => event.performance?.some(identity => identity.hand === hand));
      for (const event of events) {
        const end = event.startSeconds + Math.max(...event.pitches.map((_, index) => keyHoldSeconds(event, index)));
        for (const id of new Set([...(event.notationNoteIds ?? []), ...(event.performance ?? []).map(identity => identity.noteId)].map(id => owners.get(id)).filter((id): id is string => id !== undefined))) {
          const old = bounds.get(id);
          bounds.set(id, { start: Math.min(old?.start ?? Infinity, event.startSeconds), end: Math.max(old?.end ?? -Infinity, end) });
        }
      }
      const includeTie = (entry: LocatedTimelineNote) => {
        ids.add(entry.note.id);
        for (const member of ScoreTimeline.tieChain(project.outline, entry.note.id, selection.staff)) ids.add(member.note.id);
      };
      for (const entry of entries) includeTie(entry);
      const seed = [...ids].flatMap(id => {
        const bound = bounds.get(id);
        return bound ? [bound] : [];
      });
      const start = Math.min(...seed.map(bound => bound.start));
      const end = Math.max(...seed.map(bound => bound.end));
      // Other voices and their ties may extend outside the seed window.
      // Their tails do not enlarge the window used to find overlaps.
      for (const entry of all) {
        if (entry.voiceIndex === first.voiceIndex) continue;
        const bound = bounds.get(entry.note.id);
        if (bound && bound.start < end - 1e-8 && bound.end > start + 1e-8) includeTie(entry);
      }
      entries = all.filter(entry => ids.has(entry.note.id)).sort((a,b) => a.measureStartSixteenths + a.positionSixteenths - b.measureStartSixteenths - b.positionSixteenths || a.voiceIndex - b.voiceIndex);
      if (entries.length > 4096) issues.push({ message: 'The expanded hand passage exceeds 4096 notes. Select a shorter range.' });
    }
    return { ...seedScopeResult, entries, events };
  }

  function clearScope(project: ScoreProject, selection: FingeringSelection) {
    const { entries, issues, first } = seedScope(project, selection);
    if (issues.length) return { entries, issues };
    const { outline } = project;
    const included = new Map<string, LocatedTimelineNote>();
    const includeTie = (entry: LocatedTimelineNote) => {
      if (included.has(entry.note.id)) return;
      const chain = entry.note.tieFrom || entry.note.tieTo
        ? ScoreTimeline.tieChain(outline, entry.note.id, selection.staff) : [entry];
      for (const member of chain) included.set(member.note.id, member);
    };
    for (const entry of entries) includeTie(entry);
    const seed = [...included.values()].sort(byOnset);
    const start = onset(seed[0]), end = release(seed.at(-1)!);
    const timeline = ScoreTimeline.index(outline);
    const voices = new Set<number>();
    for (let position = start; MusicalTime.compareNumbers(position, end) < 0;) {
      const block = timeline.measureAt(position);
      if (!block) break;
      block.measure.data[selection.staff].voices.forEach((_, index) => voices.add(index));
      position = MusicalTime.addNumbers(block.startSixteenths, block.lengthSixteenths);
    }
    // Keep the search window fixed after expanding the selected ties.
    for (const voice of voices) {
      if (voice === first.voiceIndex) continue;
      for (const entry of ScoreTimeline.notesInRange(outline, selection.staff, voice, start, end)) includeTie(entry);
    }
    if (included.size > 4096) issues.push({ message: 'The expanded hand passage exceeds 4096 notes. Select a shorter range.' });
    return { entries: [...included.values()].sort(byOnset), issues };
  }

  export function inspect(project: ScoreProject, selection: FingeringSelection) {
    const { entries, ids, issues, selectedCount, first, last, events } = scope(project, selection);
    const trills = new Map((project.trills ?? []).filter(trill => ids.has(trill.startNoteId)).map(trill => [trill.startNoteId, trill]));
    const trillEvents = new Map<string, PlaybackEvent[]>();
    for (const event of events) {
      const source = event.performance?.[0];
      if (source?.trillAttackIndex === undefined || !trills.has(source.noteId)) continue;
      const sequence = trillEvents.get(source.noteId) ?? [];
      sequence.push(event);
      trillEvents.set(source.noteId, sequence);
    }
    for (const entry of entries) {
      const { note } = entry;
      const issue = (message: string, pitchIndex?: number) => issues.push({ message: `${label(project, entry, selection.staff)}: ${message}`, noteId: note.id, pitchIndex });
      if (note.arpeggio && (!ScoreArpeggio.canApply(note) || !ScoreArpeggio.validate(note.arpeggio)))
        issue('The rolled chord has invalid arpeggio settings.');
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
    const performanceAttacks = attacks.flatMap(entry => {
      const noteId = entry.note.id;
      const graces = (entry.note.beforeGraceNotes ?? []).map((grace, i) => ({
        ...entry, noteId, graceNoteId: grace.id as string | undefined, note: grace, graceIndex: i + 1,
        trillAttackIndex: undefined as number | undefined,
      }));
      const trill = trills.get(noteId);
      const principal = { ...entry, noteId, graceNoteId: undefined as string | undefined, graceIndex: 0,
        trillAttackIndex: undefined as number | undefined };
      if (!trill) return [...graces, principal];
      const sequence = trillEvents.get(noteId) ?? [];
      if (sequence.length !== trill.settings.attackCount ||
        sequence.some((event, index) => event.performance?.[0]?.trillAttackIndex !== index)) {
        issues.push({ message: `${label(project, entry, selection.staff)}: Could not resolve all attacks in the trill.`, noteId });
      }
      return [...graces, ...sequence.map(event => ({
        ...principal, trillAttackIndex: event.performance![0].trillAttackIndex,
        note: { ...entry.note, pitches: [{ midi: event.pitches[0], fingering: event.performance![0].fingering }] },
      }))];
    });
    const total = performanceAttacks.reduce((sum, entry) => sum + entry.note.pitches.length, 0);
    const fixed = performanceAttacks.reduce((sum, entry) => sum + entry.note.pitches.filter(pitch => pitch.fingering !== undefined).length, 0);
    const measures = project.outline.filter(block => block.type === 'measure');
    return { entries, attacks, performanceAttacks, events, addedNotes: entries.length - selectedCount, voiceCount: new Set(entries.map(entry => entry.voiceIndex)).size, issues, total, fixed, missing: total - fixed, voiceIndex: first?.voiceIndex ?? 0,
      firstMeasure: first ? measures.indexOf(entries[0].measure) + 1 : 0, lastMeasure: last ? measures.indexOf(entries.at(-1)!.measure) + 1 : 0 };
  }

  export function label(project: ScoreProject, entry: LocatedTimelineNote, staff: PianoStaffName) {
    const local = ScoreVoice.flatten(entry.measure.data[staff].voices[entry.voiceIndex], entry.measure.data.length)
      .filter(item => item.element.kind === 'note').findIndex(item => item.element.id === entry.note.id) + 1;
    return `Measure ${project.outline.filter(block => block.type === 'measure').indexOf(entry.measure) + 1}, voice ${entry.voiceIndex + 1}, note ${local}`;
  }

  /** Clearing annotations uses score overlap and accepts any performance technique. */
  export function clearAvailability(project: ScoreProject, selection: FingeringSelection) {
    const { entries, issues } = clearScope(project, selection);
    if (issues.length) return { allowed: false, reason: issues[0].message, entries };
    const ids = new Set(entries.map(entry => entry.note.id));
    const hasFingers = entries.some(({ note }) => [...note.pitches, ...(note.beforeGraceNotes ?? []).flatMap(grace => grace.pitches)]
      .some(pitch => pitch.fingering !== undefined || pitch.substitutionFingering !== undefined)) ||
      (project.trills ?? []).some(trill => ids.has(trill.startNoteId) && trill.settings.fingerings !== undefined);
    return { allowed: hasFingers, reason: hasFingers ? '' : 'The selection has no fingerings to clear.', entries };
  }

  export function clear(project: ScoreProject, selection: FingeringSelection): ScoreProject {
    const availability = clearAvailability(project, selection);
    if (!availability.allowed) return project;
    const ids = new Set(availability.entries.map(entry => entry.note.id));
    const strip = (pitch: PianoPitch): PianoPitch => {
      if (pitch.fingering === undefined && pitch.substitutionFingering === undefined) return pitch;
      const { fingering: _finger, substitutionFingering: _substitution, ...rest } = pitch;
      return rest;
    };
    const next = ScoreNotes.map(project, ids, note => ({ ...note, pitches: note.pitches.map(strip),
      ...(note.beforeGraceNotes ? { beforeGraceNotes: note.beforeGraceNotes.map(grace => ({ ...grace, pitches: grace.pitches.map(strip) })) } : {}) }), selection.staff);
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
    const notes = new Map(inspection.performanceAttacks.map(entry => [targetKey(entry.noteId, entry.graceNoteId, entry.trillAttackIndex), entry]));
    const changes = new Map<string, Map<number, PianoFingering>>();
    for (const assignment of assignments) {
      const id = targetKey(assignment.noteId, assignment.graceNoteId, assignment.trillAttackIndex);
      const pitch = notes.get(id)?.note.pitches[assignment.pitchIndex];
      if (!pitch || !Number.isInteger(assignment.pitchIndex) || !Number.isInteger(assignment.finger) || assignment.finger < 1 || assignment.finger > 5 ||
        pitch.fingering !== undefined || changes.get(id)?.has(assignment.pitchIndex)) return project;
      const pitches = changes.get(id) ?? new Map();
      pitches.set(assignment.pitchIndex, assignment.finger); changes.set(id, pitches);
    }
    if (assignments.length !== inspection.missing) return project;
    const updated = new Map<string, PianoPitch[]>();
    const trillUpdates = new Map<string, PianoFingering[]>();
    const changedTrills = new Set<string>();
    for (const [id, { note, noteId, trillAttackIndex }] of notes) {
      const pitches = note.pitches.map((pitch, index) => changes.get(id)?.has(index) ? { ...pitch, fingering: changes.get(id)!.get(index)! } : pitch);
      if (trillAttackIndex !== undefined) {
        const finger = pitches[0].fingering;
        if (finger === undefined) return project;
        const sequence = trillUpdates.get(noteId) ?? [];
        sequence[trillAttackIndex] = finger;
        trillUpdates.set(noteId, sequence);
        if (changes.has(id)) changedTrills.add(noteId);
        continue;
      }
      if (new Set(pitches.map(pitch => pitch.fingering)).size !== pitches.length) return project;
      updated.set(id, pitches);
    }
    const result = TieFingerings.normalize(ScoreNotes.map(project, new Set(inspection.entries.map(entry => entry.note.id)), note => ({ ...note,
      pitches: updated.get(targetKey(note.id)) ?? note.pitches,
      ...(note.beforeGraceNotes ? { beforeGraceNotes: note.beforeGraceNotes.map(grace => ({ ...grace, pitches: updated.get(targetKey(note.id, grace.id)) ?? grace.pitches })) } : {}),
    }), selection.staff));
    ScoreTimeline.inheritTiming(project.outline, result.outline);
    if (!changedTrills.size) return result;
    return { ...result, trills: result.trills?.map(trill => {
      const fingerings = trillUpdates.get(trill.startNoteId);
      return fingerings && changedTrills.has(trill.startNoteId) ? { ...trill, settings: { ...trill.settings, fingerings } } : trill;
    }) };
  }
}
export default FingeringSelection;
