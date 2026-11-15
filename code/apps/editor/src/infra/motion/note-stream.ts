import { keys } from '../../domain/motion/keyboard.ts';
import { ANIMATION_LEAD_IN } from '../../domain/performance/animation-performance.ts';
import type { PlaybackPlan } from '../../domain/performance/score-playback-plan.ts';

export const NOTE_LOOK_AHEAD = 3;
export const NOTE_TRAVEL_SPEED = 0.24;
export const NOTE_STRIKE_Z = -0.09;
export const NOTE_FAR_Z = NOTE_STRIKE_Z - NOTE_LOOK_AHEAD * NOTE_TRAVEL_SPEED;
export const NOTE_PLANE_Y = 0.022;
export type StreamNote = { start: number; end: number; midi: number; hand: 'left' | 'right'; x: number; width: number };
export type NoteBar = { note: StreamNote; front: number; back: number; active: boolean };

/** Use performed audio attacks, never the extra contacts made by substitutions. */
export function createNoteStream(playback: PlaybackPlan) {
  const notes: StreamNote[] = playback.events.flatMap(event => event.pitches.map((midi, index) => {
    const keyIndex = keys.findIndex(key => key.midiNote === midi), key = keys[keyIndex];
    if (!key) throw new Error(`No keyboard lane for MIDI ${midi}.`);
    const gap = Math.min(keyIndex > 0 ? key.target[0] - keys[keyIndex - 1].target[0] : Infinity,
      keyIndex + 1 < keys.length ? keys[keyIndex + 1].target[0] - key.target[0] : Infinity);
    const start = event.startSeconds + ANIMATION_LEAD_IN;
    return { start, end: start + (event.pitchDurationsSeconds?.[index] ?? event.durationSeconds), midi,
      hand: event.performance?.[index]?.hand ?? 'right', x: key.target[0], width: Math.min(key.width * 0.8, gap * 0.8) };
  })).sort((a, b) => a.start - b.start || a.midi - b.midi);
  const prefixEnd: number[] = [];
  for (const [index, note] of notes.entries()) prefixEnd.push(Math.max(prefixEnd[index - 1] ?? -Infinity, note.end));
  return {
    notes,
    framesAt(time: number): NoteBar[] {
      // Skip expired prefixes and stop at the future window. Held notes that
      // began before the window remain visible; seeking needs no history.
      let low = 0, high = notes.length;
      while (low < high) { const mid = (low + high) >>> 1; if (prefixEnd[mid] <= time) low = mid + 1; else high = mid; }
      const frames: NoteBar[] = [];
      for (let index = low; index < notes.length && notes[index].start < time + NOTE_LOOK_AHEAD; index++) {
        const note = notes[index];
        if (note.end <= time) continue;
        frames.push({ note, active: note.start <= time,
          front: NOTE_STRIKE_Z - Math.max(0, note.start - time) * NOTE_TRAVEL_SPEED,
          back: NOTE_STRIKE_Z - Math.min(NOTE_LOOK_AHEAD, note.end - time) * NOTE_TRAVEL_SPEED });
      }
      return frames;
    },
  };
}
