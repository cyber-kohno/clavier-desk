import { prepareMotion, type Hand, type MotionProgress, type Note, type PreparedMotion } from '../../domain/motion/motion.ts';
import type { AnimationPerformance } from '../../domain/performance/animation-performance.ts';

export type AnimationMotionInput = Pick<AnimationPerformance, 'notes' | 'origins'>;
export type AnimationProgress = Pick<MotionProgress, 'phase' | 'completed' | 'total'> & {
  hand?: Hand;
  firstMeasure?: number;
  lastMeasure?: number;
};
export type AnimationGenerationMessage =
  | { type: 'progress'; progress: AnimationProgress }
  | { type: 'result'; motion: PreparedMotion }
  | { type: 'error'; message: string };

export function generateAnimation(input: AnimationPerformance): AnimationPerformance {
  return { ...input, notes: generateAnimationMotion(input).notes };
}

export function generateAnimationMotion(input: AnimationMotionInput, progress?: (value: AnimationProgress) => void): PreparedMotion {
  const noteKey = (note: Note) => `${note.hand}/${note.time}/${note.midiNote}/${note.finger}`;
  const locations = progress && new Map(input.notes.map((note, index) => [noteKey(note), input.origins[index]]));
  try {
    return prepareMotion(input.notes, locations && progress && (({ notes, ...counts }) => {
      let firstMeasure = Infinity, lastMeasure = -Infinity;
      for (const note of notes ?? []) {
        const origin = locations.get(noteKey(note));
        if (origin?.firstMeasure === undefined) continue;
        firstMeasure = Math.min(firstMeasure, origin.firstMeasure);
        lastMeasure = Math.max(lastMeasure, origin.lastMeasure ?? origin.firstMeasure);
      }
      progress({ ...counts, hand: notes?.[0]?.hand,
        ...(firstMeasure < Infinity ? { firstMeasure, lastMeasure } : {}) });
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const match = /^(Left|Right) hand ([\d.]+) s/.exec(reason);
    const note = match && input.notes.find(note => note.hand === (match[1] === 'Left' ? 'left' : 'right') &&
      Math.abs(note.time - Number(match[2])) < 0.001);
    const origin = note && input.origins[input.notes.indexOf(note)];
    throw new Error(`${origin ? `${origin.label}. ` : ''}${reason}`);
  }
}
