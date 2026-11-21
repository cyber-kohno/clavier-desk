import ReattackPerformance from './reattack-performance.ts';
import ScoreDynamics from '../score/score-dynamics.ts';
import ScoreTimeline, { type LocatedTimelineNote } from '../score/score-timeline.ts';
import ScoreClock from './score-clock.ts';
import StaccatoPerformance from './staccato-performance.ts';
import TrillPerformance from './trill-performance.ts';
import ArpeggioPerformance from './arpeggio-performance.ts';
import GraceNotePerformance from './grace-note-performance.ts';
import ScoreArpeggio from '../score/score-arpeggio.ts';
import ScoreKey from '../score/score-key.ts';
import TrillPitch from '../theory/trill-pitch.ts';
import ScorePedal from '../score/score-pedal.ts';
import ArticulationPerformance from './articulation-performance.ts';
import ScoreFermata from '../score/score-fermata.ts';
import TieFingerings from '../score/tie-fingerings.ts';
import { soundingVelocity } from '../score/pitch-velocity.ts';
import { MIN_REATTACK_GAP_SECONDS } from '../theory/performance-timing.ts';
import type { ScoreProject, PianoStaffName, PianoPitch, ArpeggioSettings } from '../score/types.ts';

/** Identity and fingering travel with the performed attack, including ornaments. */
export type PerformancePitch = {
  hand: 'left' | 'right';
  voice: string;
  fingering?: PianoPitch['fingering'];
  substitutionFingering?: PianoPitch['substitutionFingering'];
  noteId: string;
  pitchIndex: number;
  trillAttackIndex?: number;
};

export type PlaybackEvent = {
  startSeconds: number;
  durationSeconds: number;
  pitches: number[];
  performance?: PerformancePitch[];
  /** Per-pitch lengths are used when a chord's pitches articulate differently. */
  pitchDurationsSeconds?: number[];
  /** Upper bound on key hold when a slur extends the sounding duration. */
  keyHoldLimitsSeconds?: number[];
  graceNote?: boolean;
  /** Principal onset of the rolled chord, before distributing its attacks. */
  rollAnchorSeconds?: number;
  /** Shared MIDI attack velocity before any per-pitch overrides. */
  velocity?: number;
  /** Absolute MIDI velocities in pitches order, when at least one pitch is adjusted. */
  pitchVelocities?: number[];
  sourceNoteId: string;
  notationNoteIds?: string[];
  notationRanges?: { noteId: string; startSeconds: number; endSeconds?: number }[];
};

export function keyHoldSeconds(event: PlaybackEvent, index: number): number {
  return Math.min(event.pitchDurationsSeconds?.[index] ?? event.durationSeconds,
    event.keyHoldLimitsSeconds?.[index] ?? Infinity);
}
export type PlaybackPedalEvent = { atSeconds: number; action: 'start' | 'change' | 'stop' };
export type PlaybackPlan = {
  startPosition: number;
  endPosition: number;
  durationSeconds: number;
  pedalInitiallyDown: boolean;
  pedalEvents: PlaybackPedalEvent[];
  events: PlaybackEvent[];
};
type Prepared = {
  velocityAt: ReturnType<typeof ScoreDynamics.createVelocityLookup>;
  voices: { staff: PianoStaffName; voiceIndex: number; groups: LocatedTimelineNote[][] }[];
  slursByNote: Map<string, Set<string>>;
  clock: ReturnType<typeof ScoreClock.create>;
  playbackClock: ReturnType<typeof ScoreClock.create>;
  keys: ReturnType<typeof ScoreKey.buildMeasureCache>;
  trills: Map<string, NonNullable<ScoreProject['trills']>[number]>;
  pedalEvents: ReturnType<typeof ScorePedal.events>;
  endPosition: number;
};

namespace ScorePlaybackPlan {
  function graceTiming(note: LocatedTimelineNote['note'], noteStartSeconds: number,
    sixteenthSeconds: number, startSeconds: number) {
    const attacks = GraceNotePerformance.attacks(note.beforeGraceNotes ?? [],
      note.gracePerformance ?? GraceNotePerformance.defaults, sixteenthSeconds);
    const tail = attacks.at(-1);
    const shift = tail ? Math.max(0, startSeconds - (noteStartSeconds + attacks[0].offset)) : 0;
    const principalStartSeconds = tail ? noteStartSeconds + (tail.offset + tail.duration + shift) : noteStartSeconds;
    return { attacks, shift, principalStartSeconds };
  }

  function rollTiming(pitches: PianoPitch[], settings: ArpeggioSettings, principalStartSeconds: number,
    sixteenthSeconds: number, startSeconds: number, keepPreRoll: boolean) {
    const attacks = ArpeggioPerformance.attacks(pitches, settings, sixteenthSeconds);
    const earliest = principalStartSeconds + (attacks[0]?.offset ?? 0);
    const shift = keepPreRoll ? Math.max(0, startSeconds - earliest) : 0;
    return { attacks, shift };
  }

  function unadjustedVelocity(velocityAt: Prepared['velocityAt'], clock: Prepared['clock'], seconds: number,
    note: LocatedTimelineNote['note'], grace: boolean) {
    return velocityAt(clock.positionAt(seconds)) + (grace ? 0 : note.accent?.velocityOffset ?? 0);
  }

  /** Velocity before pitch adjustment and MIDI limits, at the first attack when played from the score start. */
  export function createAttackVelocityLookup(project: ScoreProject) {
    const clock = ScoreClock.createTempo(project);
    const velocityAt = ScoreDynamics.createVelocityLookup(project);
    return (located: LocatedTimelineNote, pitchIndex: number, graceNoteId?: string) => {
      const { note } = located;
      const noteStart = located.measureStartSixteenths + located.positionSixteenths;
      const noteStartSeconds = clock.secondsAt(noteStart);
      const sixteenthSeconds = clock.secondsAt(noteStart + 1) - noteStartSeconds;
      const startSeconds = clock.secondsAt(0);
      const grace = graceTiming(note, noteStartSeconds, sixteenthSeconds, startSeconds);
      let onset = grace.principalStartSeconds; // The first trill attack also starts here.
      if (graceNoteId !== undefined) {
        const index = note.beforeGraceNotes?.findIndex(entry => entry.id === graceNoteId) ?? -1;
        const attack = grace.attacks[index];
        if (attack) onset = noteStartSeconds + attack.offset + grace.shift;
      } else if (note.arpeggio && ScoreArpeggio.canApply(note)) {
        const roll = rollTiming(note.pitches, note.arpeggio, onset, sixteenthSeconds, startSeconds, true);
        const attack = roll.attacks.find(entry => entry.midi === note.pitches[pitchIndex]?.midi);
        if (attack) onset = onset + attack.offset + roll.shift;
      }
      return unadjustedVelocity(velocityAt, clock, Math.max(startSeconds, onset), note, graceNoteId !== undefined);
    };
  }

  /** Derived data is reused for every start position within one editor revision. */
  export function prepare(project: ScoreProject) {
    const voices = [];
    const notesById = new Map<string, { staff: PianoStaffName; voiceIndex: number; index: number; notes: LocatedTimelineNote[] }>();
    for (const staff of ['upperStaff', 'lowerStaff'] as const) {
      const count = Math.max(0, ...project.outline.map(block => block.type === 'measure' ? block.data[staff].voices.length : 0));
      for (let voiceIndex = 0; voiceIndex < count; voiceIndex++) {
        const notes = ScoreTimeline.notes(project.outline, staff, voiceIndex);
        const byId = new Map(notes.map(entry => [entry.note.id, entry]));
        notes.forEach((entry, index) => notesById.set(entry.note.id, { staff, voiceIndex, index, notes }));
        const visited = new Set<string>();
        const groups: LocatedTimelineNote[][] = [];
        for (const entry of notes) {
          if (visited.has(entry.note.id)) continue;
          let head = entry;
          const seen = new Set([head.note.id]);
          while (head.note.tieFrom) {
            const previous = byId.get(head.note.tieFrom);
            if (!previous || previous.note.tieTo !== head.note.id || seen.has(previous.note.id)) break;
            seen.add(previous.note.id);
            head = previous;
          }
          const members: LocatedTimelineNote[] = [];
          seen.clear();
          for (let current: LocatedTimelineNote | undefined = head; current && !seen.has(current.note.id);) {
            members.push(current);
            seen.add(current.note.id);
            visited.add(current.note.id);
            const next: LocatedTimelineNote | undefined = current.note.tieTo ? byId.get(current.note.tieTo) : undefined;
            current = next?.note.tieFrom === current.note.id ? next : undefined;
          }
          if (head.note.tieFrom && byId.has(head.note.tieFrom)) continue;
          groups.push(members);
        }
        voices.push({ staff, voiceIndex, groups });
      }
    }
    const slursByNote = new Map<string, Set<string>>();
    for (const slur of project.slurs ?? []) {
      const first = notesById.get(slur.startNoteId), last = notesById.get(slur.endNoteId);
      if (!first || !last || first.staff !== last.staff || first.voiceIndex !== last.voiceIndex || first.index >= last.index) continue;
      for (let index = first.index; index <= last.index; index++) {
        const id = first.notes[index].note.id;
        let ids = slursByNote.get(id);
        if (!ids) slursByNote.set(id, ids = new Set());
        ids.add(slur.id);
      }
    }
    const clock = ScoreClock.createTempo(project);
    const prepared = { velocityAt: ScoreDynamics.createVelocityLookup(project), voices, slursByNote, clock,
      playbackClock: ScoreClock.withFermatas(clock, ScoreFermata.groups(project)),
      keys: ScoreKey.buildMeasureCache(project.outline),
      trills: new Map((project.trills ?? []).map(trill => [trill.startNoteId, trill])),
      pedalEvents: ScorePedal.events(project), endPosition: ScoreTimeline.length(project.outline) };
    return { clock: prepared.playbackClock,
      create: (requestedStart: number) => createPrepared(project, requestedStart, prepared) };
  }

  /** Creates a playback snapshot. Performance expressions affect sounding events, never written score timing. */
  export function create(project: ScoreProject, requestedStart: number): PlaybackPlan {
    return prepare(project).create(requestedStart);
  }

  function createPrepared(project: ScoreProject, requestedStart: number, prepared: Prepared): PlaybackPlan {
    const { endPosition, clock } = prepared;
    const startPosition = Math.max(0, Math.min(endPosition, requestedStart));
    const startSeconds = clock.secondsAt(startPosition);
    const pedalScoreEvents = prepared.pedalEvents;
    const precedingPedalEvent = pedalScoreEvents.filter(event => event.position < startPosition).at(-1);
    const pedalInitiallyDown = precedingPedalEvent !== undefined && precedingPedalEvent.action !== 'stop';
    const pedalEvents = pedalScoreEvents.filter(event => event.position >= startPosition && event.position <= endPosition)
      .map(event => ({ atSeconds: clock.secondsAt(event.position) - startSeconds, action: event.action }));
    const events: PlaybackEvent[] = [];
    const noteGroups: {
      staff: PianoStaffName; voiceIndex: number; slurIds: Set<string>; startPosition: number; endPosition: number;
      startSeconds: number; endSeconds: number; hasStaccato: boolean; tied: boolean; events: PlaybackEvent[];
    }[] = [];
    for (const { staff, voiceIndex, groups } of prepared.voices) {
      for (const members of groups) {
        const first = members[0];
        const last = members[members.length - 1];
        const heldPitches = TieFingerings.read(members.map(member => member.note)).pitches;
        const identity = (pitches: PianoPitch[], noteId = first.note.id): PerformancePitch[] => pitches.map((pitch, pitchIndex) => ({
          hand: staff === 'upperStaff' ? 'right' : 'left', voice: `${staff}:${voiceIndex}`,
          fingering: (noteId === first.note.id ? heldPitches[pitchIndex] : pitch).fingering,
          substitutionFingering: (noteId === first.note.id ? heldPitches[pitchIndex] : pitch).substitutionFingering, noteId, pitchIndex,
        }));
        const noteStart = first.measureStartSixteenths + first.positionSixteenths;
        const noteEnd = last.measureStartSixteenths + last.positionSixteenths + last.lengthSixteenths;
        if (noteStart >= endPosition || first.note.pitches.length === 0) continue;
        const tailStart = last.measureStartSixteenths + last.positionSixteenths;
        const performedEndSeconds = StaccatoPerformance.soundingEndSeconds(
          project, Math.min(noteEnd, endPosition), tailStart, last.lengthSixteenths, last.note.staccato, clock.secondsAt,
        );
        const noteStartSeconds = clock.secondsAt(noteStart);
        let principalStartSeconds = noteStartSeconds;
        const graceEvents: PlaybackEvent[] = [];
        const graces = first.note.beforeGraceNotes;
        if (graces?.length && noteStart >= startPosition) {
          const sixteenthSeconds = clock.secondsAt(noteStart + 1) - noteStartSeconds;
          // Shift the complete grace sequence when playback begins before its pre-roll.
          const timing = graceTiming(first.note, noteStartSeconds, sixteenthSeconds, startSeconds);
          const { attacks, shift: preRollShift } = timing;
          principalStartSeconds = timing.principalStartSeconds;
          attacks.forEach((attack, index) => {
            const onset = noteStartSeconds + attack.offset + preRollShift;
            const effectiveOnset = Math.max(onset, startSeconds);
            const nextOnset = index + 1 < attacks.length
              ? noteStartSeconds + attacks[index + 1].offset + preRollShift
              : principalStartSeconds;
            const duration = nextOnset - effectiveOnset;
            if (duration <= 0) return;
            const grace = graces[index];
            graceEvents.push({ startSeconds: effectiveOnset - startSeconds, durationSeconds: duration,
              pitches: [attack.midi], performance: identity(grace.pitches, grace.id),
              sourceNoteId: `${first.note.id}-grace-${index}`, graceNote: true, notationNoteIds: [grace.id] });
          });
        }
        const effectiveStartSeconds = Math.max(principalStartSeconds, startSeconds);
        if (performedEndSeconds <= effectiveStartSeconds && graceEvents.length === 0) continue;
        const noteEvents: PlaybackEvent[] = [...graceEvents];
        const trill = prepared.trills.get(first.note.id);
        if (performedEndSeconds > effectiveStartSeconds && trill && trill.startNoteId === first.note.id && trill.endNoteId === last.note.id &&
          members.every(member => member.note.pitches.length === 1 && member.note.pitches[0].midi === first.note.pitches[0].midi)) {
          const mainPitch = first.note.pitches[0].midi;
          const auxiliaryPitch = TrillPitch.above(mainPitch,
            prepared.keys.get(first.measure.id)!.keySignature, trill.settings.auxiliary).midi;
          const trillStartSeconds = principalStartSeconds;
          const trillDurationSeconds = performedEndSeconds - trillStartSeconds;
          const elapsedSeconds = Math.max(0, startSeconds - trillStartSeconds);
          const attacks = TrillPerformance.attacks(mainPitch, auxiliaryPitch, trill.settings, trillDurationSeconds);
          attacks.forEach((attack, index) => {
            const attackEnd = attack.offset + attack.duration;
            if (attackEnd <= elapsedSeconds) return;
            const onset = Math.max(attack.offset, elapsedSeconds);
            noteEvents.push({ startSeconds: trillStartSeconds - startSeconds + onset,
              durationSeconds: attackEnd - onset, pitches: [attack.midi],
              performance: [{ ...identity(first.note.pitches)[0], fingering: trill.settings.fingerings?.[index],
                substitutionFingering: undefined, trillAttackIndex: index }],
              sourceNoteId: `${first.note.id}-trill-${index}` });
          });
        } else if (performedEndSeconds > effectiveStartSeconds && first.note.arpeggio && ScoreArpeggio.canApply(first.note)) {
          const sixteenthSeconds = clock.secondsAt(noteStart + 1) - clock.secondsAt(noteStart);
          // A transport cannot sound notes before its start. Preserve the roll by shifting
          // this arpeggio forward as a group when playback begins before its pre-roll.
          const { attacks, shift: preRollShift } = rollTiming(first.note.pitches, first.note.arpeggio, principalStartSeconds,
            sixteenthSeconds, startSeconds, startPosition <= noteStart);
          attacks.forEach((attack, index) => {
            const absoluteAttackSeconds = principalStartSeconds + attack.offset + preRollShift;
            const effectiveAttackSeconds = Math.max(absoluteAttackSeconds, startSeconds);
            if (effectiveAttackSeconds >= performedEndSeconds) return;
            noteEvents.push({ startSeconds: effectiveAttackSeconds - startSeconds,
              durationSeconds: performedEndSeconds - effectiveAttackSeconds, pitches: [attack.midi],
              performance: [{ ...identity(first.note.pitches)[first.note.pitches.findIndex(pitch => pitch.midi === attack.midi)] }],
              rollAnchorSeconds: principalStartSeconds + preRollShift - startSeconds,
              sourceNoteId: `${first.note.id}-arpeggio-${index}` });
          });
        } else if (performedEndSeconds > effectiveStartSeconds) {
          const eventStart = effectiveStartSeconds - startSeconds;
          const eventEnd = performedEndSeconds - startSeconds;
          noteEvents.push({ startSeconds: eventStart, durationSeconds: eventEnd - eventStart,
            pitches: first.note.pitches.map(pitch => pitch.midi), performance: identity(first.note.pitches), sourceNoteId: first.note.id });
        }
        for (const event of noteEvents) {
          event.notationNoteIds ??= members.map(member => member.note.id);
          if (!event.graceNote && members.length > 1) event.notationRanges = members.map((member, index) => ({
            noteId: member.note.id,
            startSeconds: index === 0 ? event.startSeconds : clock.secondsAt(member.measureStartSixteenths + member.positionSixteenths) - startSeconds,
            endSeconds: index === members.length - 1 ? undefined : clock.secondsAt(member.measureStartSixteenths + member.positionSixteenths + member.lengthSixteenths) - startSeconds,
          }));
          const unadjusted = unadjustedVelocity(prepared.velocityAt, clock, startSeconds + event.startSeconds,
            first.note, event.graceNote === true);
          const writtenPitches = event.graceNote
            ? graces?.find(grace => grace.id === event.performance?.[0].noteId)?.pitches
            : first.note.pitches;
          event.velocity = soundingVelocity(unadjusted);
          if (writtenPitches?.some(pitch => pitch.velocityOffset) && event.performance) {
            event.pitchVelocities = event.performance.map(({ pitchIndex }) =>
              soundingVelocity(unadjusted, writtenPitches[pitchIndex]?.velocityOffset));
          }
        }
        if (noteEvents.length === 0) continue;
        events.push(...noteEvents);
        noteGroups.push({ staff, voiceIndex, slurIds: new Set(members.flatMap(member => [...(prepared.slursByNote.get(member.note.id) ?? [])])),
          startPosition: noteStart, endPosition: noteEnd, startSeconds: clock.secondsAt(noteStart),
          endSeconds: performedEndSeconds, hasStaccato: last.note.staccato !== undefined, tied: members.length > 1, events: noteEvents });
      }
    }

    // Articulation changes the sounding end of a note only at a continuous transition;
    // written positions, rests and later note onsets remain untouched.
    const samePosition = (a: number, b: number) => Math.abs(a - b) < 1e-8;
    for (let index = 0; index < noteGroups.length; index++) {
      const group = noteGroups[index], next = noteGroups[index + 1];
      if (!next || next.staff !== group.staff || next.voiceIndex !== group.voiceIndex ||
        !samePosition(next.startPosition, group.endPosition) || group.hasStaccato) continue;
      const slurred = [...group.slurIds].some(id => next.slurIds.has(id));
      const nextOnsetSeconds = Math.min(...next.events.map(event => event.startSeconds)) + startSeconds;
      const interval = next.startSeconds - group.startSeconds;
      if (interval <= 0) continue;
      const nextPitchOnsets = new Map<number, number>();
      for (const event of next.events) for (const pitch of event.pitches) {
        const onset = event.startSeconds + startSeconds;
        nextPitchOnsets.set(pitch, Math.min(nextPitchOnsets.get(pitch) ?? Infinity, onset));
      }
      const groupTailSeconds = group.endSeconds - startSeconds;
      for (const event of group.events) {
        if (event.graceNote) continue;
        const eventEnd = event.startSeconds + event.durationSeconds;
        // For multi-attack ornaments, only the final attack reaches the note boundary.
        if (eventEnd < groupTailSeconds - 1e-7) continue;
        const ends = event.pitches.map(pitch => {
          const samePitchOnset = nextPitchOnsets.get(pitch);
          const target = ArticulationPerformance.transitionEndSeconds(
            slurred && samePitchOnset !== undefined ? samePitchOnset : nextOnsetSeconds,
            interval, slurred, samePitchOnset !== undefined,
          );
          const currentEnd = event.startSeconds + event.durationSeconds + startSeconds;
          return Math.max(0.001, (slurred ? Math.max(currentEnd, target) : Math.min(currentEnd, target)) -
            (event.startSeconds + startSeconds));
        });
        if (ends.length > 0) {
          if (slurred) {
            // A legato sound tail does not require holding the previous key through
            // the next attack. Keep written tie holds and let reattack timing handle repeated keys.
            const release = nextOnsetSeconds - MIN_REATTACK_GAP_SECONDS;
            const keyEnd = group.tied ? Math.max(release, group.endSeconds) : release;
            const limit = Math.max(0.001, keyEnd - startSeconds - event.startSeconds);
            event.keyHoldLimitsSeconds = event.pitches.map((pitch, index) =>
              nextPitchOnsets.has(pitch) ? ends[index] : Math.min(ends[index], limit));
          }
          event.pitchDurationsSeconds = ends;
          event.durationSeconds = Math.max(...ends);
        }
      }
    }

    events.sort((a, b) => a.startSeconds - b.startSeconds || a.sourceNoteId.localeCompare(b.sourceNoteId));
    const scoreDuration = Math.max(0, clock.secondsAt(endPosition) - startSeconds);
    const eventDuration = events.reduce((maximum, event) => Math.max(maximum, event.startSeconds + event.durationSeconds), 0);
    const plan = { startPosition, endPosition, durationSeconds: Math.max(scoreDuration, eventDuration),
      pedalInitiallyDown, pedalEvents, events };
    if (prepared.playbackClock === clock) return { ...plan, events: ReattackPerformance.apply(plan.events) };
    // Build ornaments and articulations in base time first. Stretch each onset/release
    // afterwards, so attacks crossing a boundary slow only inside the fermata range.
    const performedStart = prepared.playbackClock.secondsAt(startPosition);
    const timeAt = (seconds: number) => prepared.playbackClock.secondsAt(clock.positionAt(startSeconds + seconds)) - performedStart;
    return { ...plan, durationSeconds: timeAt(plan.durationSeconds),
      pedalEvents: pedalEvents.map(event => ({ ...event, atSeconds: timeAt(event.atSeconds) })),
      events: ReattackPerformance.apply(events.map(event => {
        const start = timeAt(event.startSeconds);
        const pitchDurationsSeconds = event.pitchDurationsSeconds?.map(duration => timeAt(event.startSeconds + duration) - start);
        const keyHoldLimitsSeconds = event.keyHoldLimitsSeconds?.map(duration => timeAt(event.startSeconds + duration) - start);
        return { ...event, startSeconds: start,
          ...(event.rollAnchorSeconds !== undefined ? { rollAnchorSeconds: timeAt(event.rollAnchorSeconds) } : {}),
          notationRanges: event.notationRanges?.map(range => ({ ...range, startSeconds: timeAt(range.startSeconds), endSeconds: range.endSeconds === undefined ? undefined : timeAt(range.endSeconds) })),
          durationSeconds: timeAt(event.startSeconds + event.durationSeconds) - start,
          ...(pitchDurationsSeconds ? { pitchDurationsSeconds } : {}),
          ...(keyHoldLimitsSeconds ? { keyHoldLimitsSeconds } : {}) };
      })) };
  }
}
export default ScorePlaybackPlan;
