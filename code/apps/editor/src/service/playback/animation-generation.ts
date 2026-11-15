import { preparePerformance, validate } from '../../domain/motion/motion.ts';
import type { AnimationPerformance } from '../../domain/performance/animation-performance.ts';

export function generateAnimation(input: AnimationPerformance): AnimationPerformance {
  try {
    const notes = validate(input.notes);
    preparePerformance(notes);
    return { ...input, notes };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const match = /^(Left|Right) hand ([\d.]+) s/.exec(reason);
    const note = match && input.notes.find(note => note.hand === (match[1] === 'Left' ? 'left' : 'right') &&
      Math.abs(note.time - Number(match[2])) < 0.001);
    const origin = note && input.origins[input.notes.indexOf(note)];
    throw new Error(`${origin ? `${origin.label}. ` : ''}${reason}`);
  }
}
