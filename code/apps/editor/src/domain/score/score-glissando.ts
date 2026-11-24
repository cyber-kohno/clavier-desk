import MusicalTime from '../theory/musical-time.ts';
import { isBlackKey } from '../theory/piano-key.ts';
import ScoreTimeline, { type LocatedTimelineNote } from './score-timeline.ts';
import ScoreNotes from './score-notes.ts';
import TieFingerings from './tie-fingerings.ts';
import type { Glissando, GlissandoEndpoint, PianoStaffName, ScoreProject } from './types.ts';

type Project = Pick<ScoreProject, 'outline' | 'glissandi' | 'trills'>;
type Entry = LocatedTimelineNote & { staff: PianoStaffName; onset: number };

namespace ScoreGlissando {
  function entries(outline: Project['outline']) {
    const result = new Map<string, Entry>();
    for (const staff of ['upperStaff', 'lowerStaff'] as const) {
      for (const entry of ScoreTimeline.allNotes(outline, staff)) {
        result.set(entry.note.id, { ...entry, staff,
          onset: MusicalTime.addNumbers(entry.measureStartSixteenths, entry.positionSixteenths) });
      }
    }
    return result;
  }

  function endpointExists(entry: Entry | undefined, endpoint: GlissandoEndpoint) {
    return entry?.note.pitches.some(pitch => pitch.midi === endpoint.midi);
  }

  export function whiteKeysBetween(from: number, to: number) {
    const keys: number[] = [], direction = Math.sign(to - from);
    for (let midi = from + direction; midi !== to; midi += direction) {
      if (!isBlackKey(midi)) keys.push(midi);
    }
    return keys;
  }

  function reason(first: Entry, last: Entry, project: Project, notes: Map<string, Entry>) {
    if (first.staff !== last.staff || first.voiceIndex !== last.voiceIndex ||
      MusicalTime.compareNumbers(MusicalTime.addNumbers(first.onset, first.lengthSixteenths), last.onset) !== 0)
      return 'Select two adjacent notes in the same staff and voice, with no rest between them.';
    if (first.note.pitches.length !== 1 || last.note.pitches.length !== 1)
      return 'Both glissando endpoints must be single notes.';
    const from = first.note.pitches[0].midi, to = last.note.pitches[0].midi;
    if (isBlackKey(from) || isBlackKey(to) || !whiteKeysBetween(from, to).length)
      return 'Select two white keys with at least one white key between them.';
    if (first.note.tieFrom || first.note.tieTo || last.note.tieFrom)
      return 'Both endpoints must be attacks, and the starting note cannot continue into a tie.';
    if (first.note.beforeGraceNotes?.length || last.note.beforeGraceNotes?.length ||
      project.trills?.some(trill => trill.startNoteId === first.note.id || trill.startNoteId === last.note.id))
      return 'Glissando cannot share an endpoint with grace notes or a trill.';
    for (const entry of notes.values()) {
      if (entry.staff !== first.staff || entry.voiceIndex === first.voiceIndex) continue;
      const end = MusicalTime.addNumbers(entry.onset, entry.lengthSixteenths);
      if (MusicalTime.compareNumbers(entry.onset, last.onset) < 0 &&
        MusicalTime.compareNumbers(first.onset, end) < 0)
        return 'The same hand has another note during the glissando.';
    }
    return '';
  }

  export function ranges(project: Project) {
    if (!project.glissandi?.length) return [];
    const notes = entries(project.outline);
    return project.glissandi.flatMap(span => {
      const first = notes.get(span.start.noteId), last = notes.get(span.end.noteId);
      if (!first || !last || !endpointExists(first, span.start) || !endpointExists(last, span.end) ||
        MusicalTime.compareNumbers(first.onset, last.onset) >= 0) return [];
      const playbackReason = span.keySet === 'black' ? 'Black-key glissando playback is unavailable.' :
        reason(first, last, project, notes);
      return [{ span, first, last, playbackReason }];
    });
  }

  export function endpointRoles(spans: ReturnType<typeof ranges>) {
    const roles = new Map<string, { start?: true; end?: true }>();
    for (const { span, playbackReason } of spans) {
      if (playbackReason) continue;
      roles.set(span.start.noteId, { ...roles.get(span.start.noteId), start: true });
      roles.set(span.end.noteId, { ...roles.get(span.end.noteId), end: true });
    }
    return roles;
  }

  export function fingeringNotes(project: Project, spans = ranges(project)) {
    const notes = new Map<string, PianoStaffName>();
    for (const { first, last, playbackReason } of spans) {
      if (playbackReason) continue;
      notes.set(first.note.id, first.staff);
      for (const { note } of ScoreTimeline.tieChain(project.outline, last.note.id, last.staff)) {
        notes.set(note.id, last.staff);
      }
    }
    return notes;
  }

  export function clearFingerings(project: ScoreProject, spans = ranges(project)): ScoreProject {
    if (!spans.length) return project;
    let result = project;
    const notes = fingeringNotes(project, spans);
    for (const staff of ['upperStaff', 'lowerStaff'] as const) {
      const ids = new Set([...notes].filter(([, owner]) => owner === staff).map(([id]) => id));
      result = ScoreNotes.map(result, ids, note => {
        const pitches = note.pitches.map(pitch => pitch.fingering === undefined && pitch.substitutionFingering === undefined
          ? pitch : TieFingerings.strip(pitch));
        return pitches.every((pitch, index) => pitch === note.pitches[index]) ? note : { ...note, pitches };
      }, staff);
    }
    ScoreTimeline.inheritTiming(project.outline, result.outline);
    return result;
  }

  export function availability(project: ScoreProject, ids: readonly string[]) {
    const selected = inSelection(project, ids);
    const notes = ids.length === 2 ? entries(project.outline) : undefined;
    const endpoints = notes ? ids.flatMap(id => notes.get(id) ?? []).sort((a, b) => a.onset - b.onset) : [];
    const [first, last] = endpoints;
    const addReason = !first || !last ? 'Select two notes.' :
      selected.length ? 'These notes already have a glissando.' : reason(first, last, project, notes!);
    return { first, last, addReason, selected };
  }

  function inSelection(project: Project, ids: readonly string[]) {
    if (!ids.length || ids.length > 2) return [];
    return (project.glissandi ?? []).filter(span => ids.every(id => id === span.start.noteId || id === span.end.noteId));
  }

  export function add(project: ScoreProject, ids: readonly string[]): ScoreProject {
    const { first, last, addReason } = availability(project, ids);
    if (addReason || !first || !last) return project;
    const start = { noteId: first.note.id, midi: first.note.pitches[0].midi };
    const end = { noteId: last.note.id, midi: last.note.pitches[0].midi };
    return clearFingerings({ ...project, glissandi: [...(project.glissandi ?? []), {
      id: crypto.randomUUID(), start, end, lineType: 'wavy', keySet: 'white',
    }] });
  }

  export function remove(project: ScoreProject, ids: readonly string[]): ScoreProject {
    const selected = inSelection(project, ids);
    if (selected.length !== 1) return project;
    return { ...project, glissandi: project.glissandi!.filter(span => span !== selected[0]) };
  }

  export function reconcile(project: ScoreProject): ScoreProject {
    const valid = ranges(project);
    return valid.length === (project.glissandi?.length ?? 0) ? project :
      { ...project, glissandi: valid.map(({ span }) => span) };
  }
}

export default ScoreGlissando;
