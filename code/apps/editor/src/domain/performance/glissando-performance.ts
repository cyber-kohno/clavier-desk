import ScoreGlissando from '../score/score-glissando.ts';
import { soundingVelocity } from '../score/pitch-velocity.ts';
import type { PianoFingering } from '../score/types.ts';
import type { PlaybackEvent } from './score-playback-plan.ts';
import type { Note } from '../motion/motion.ts';

export type GlissandoStep = {
  id: string;
  index: number;
  finger: PianoFingering;
  attackSeconds: number;
  nextMidi: number;
  nextSeconds: number;
  sweepEndSeconds: number;
};

export function glissandoMotion(event: PlaybackEvent, offset: number):
    Pick<Note, 'finger' | 'glissando' | 'glissandoArrival'> | undefined {
  const step = event.glissando, arrival = event.glissandoArrival;
  const contact = step ?? arrival;
  if (!contact) return undefined;
  return {
    finger: contact.finger,
    ...(arrival ? { glissandoArrival: arrival.id } : {}),
    ...(step ? { glissando: { id: step.id, nextMidi: step.nextMidi,
      attackTime: step.attackSeconds + offset, nextTime: step.nextSeconds + offset,
      sweepEndTime: step.sweepEndSeconds + offset } } : {}),
  };
}

export function expandGlissandi(events: PlaybackEvent[], ranges: ReturnType<typeof ScoreGlissando.ranges>,
    secondsAt: (position: number) => number, velocityAt: (seconds: number) => number) {
  if (!ranges.length) return events;
  const ordinary = new Map(events.map(event => [event.sourceNoteId, event]));
  const replacements = new Map<PlaybackEvent, PlaybackEvent>();
  const added: PlaybackEvent[] = [];
  for (const { span, first, last, playbackReason } of [...ranges].sort((a, b) => a.first.onset - b.first.onset)) {
    if (playbackReason) continue;
    const start = ordinary.get(span.start.noteId), end = ordinary.get(span.end.noteId);
    if (!end?.performance?.[0] || replacements.get(end)?.glissandoArrival ||
      (start && replacements.get(start)?.glissando)) continue;
    const from = secondsAt(first.onset), to = secondsAt(last.onset);
    if (to <= 0 || to <= from) continue;
    const hand = end.performance[0].hand;
    // The contact point belongs to the fixed hand pose, independent of score fingering.
    const defaultContact = (hand === 'right') === (span.start.midi < span.end.midi) ? 2 : 1;
    const finger = (start && replacements.get(start)?.glissandoArrival?.finger) ?? defaultContact;
    const pitches = [span.start.midi, ...ScoreGlissando.whiteKeysBetween(span.start.midi, span.end.midi), span.end.midi];
    const interval = (to - from) / (pitches.length - 1);
    let hasSweep = false;
    for (let index = 0; index < pitches.length - 1; index++) {
      const attack = from + index * interval;
      const next = index === pitches.length - 2 ? to : from + (index + 1) * interval;
      const onset = Math.max(0, attack);
      if (next <= onset) continue;
      const glissando = { id: span.id, index, finger, attackSeconds: attack,
        nextMidi: pitches[index + 1], nextSeconds: next, sweepEndSeconds: next };
      if (index === 0) {
        if (!start) continue;
        const original = replacements.get(start) ?? start;
        const duration = Math.min(original.durationSeconds, next - original.startSeconds);
        if (duration <= 0) continue;
        replacements.set(start, { ...original, glissando, durationSeconds: duration,
          pitchDurationsSeconds: [duration], keyHoldLimitsSeconds: [Math.min(original.keyHoldLimitsSeconds?.[0] ?? duration, duration)] });
      } else {
        const duration = next - onset;
        added.push({ glissando, startSeconds: onset, durationSeconds: duration, pitches: [pitches[index]],
          performance: [{ hand, voice: end.performance[0].voice, noteId: first.note.id, pitchIndex: 0 }],
          velocity: soundingVelocity(velocityAt(onset)), sourceNoteId: `${span.id}/${index}`, notationNoteIds: [first.note.id] });
      }
      hasSweep = true;
    }
    if (hasSweep) replacements.set(end, { ...(replacements.get(end) ?? end), glissandoArrival: { id: span.id, finger } });
  }
  return [...events.map(event => replacements.get(event) ?? event), ...added]
    .sort((a, b) => a.startSeconds - b.startSeconds || a.sourceNoteId.localeCompare(b.sourceNoteId));
}
