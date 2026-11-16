import { keys, WIDTH } from '../motion/keyboard.ts';
import { fingers, fingerPoints } from '../motion/fingers.ts';
import type { Finger } from '../motion/fingers.ts';
import { planChord } from '../motion/chords.ts';
import { validate, preparePerformance, type Note } from '../motion/motion.ts';
import type { FingeringPassage, FingeringStep } from './fingering-passage.ts';
import type { FingeringAssignment, FingeringIssue } from '../score/fingering-selection.ts';

export type FingeringProgress = { phase: 'search' | 'validate'; completed: number; total: number };
export type FingeringDraft = { assignments: FingeringAssignment[]; warnings: FingeringIssue[]; cost: number };
export type FingeringResult = { candidates: FingeringDraft[]; issues: FingeringIssue[] };
type Candidate = { fingers: Finger[]; palm: number; cost: number };
type Path = { candidate: Candidate; previous?: Path; cost: number; stepCost: number };

namespace AutomaticFingering {
  const beamWidth = 96, validationLimit = 16;
  const keyByMidi = new Map(keys.map(key => [key.midiNote, key]));

  function candidates(passage: FingeringPassage, step: FingeringStep, cache: Map<string, Candidate[]>): Candidate[] {
    const cacheKey = step.attacks.map(attack => `${attack.midi}:${attack.fixed ?? 0}`).join(',');
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const ordered = step.attacks.map((attack, index) => ({ ...attack, index })).sort((a, b) => a.midi - b.midi);
    const assignments: Finger[][] = [];
    function enumerate(index: number, chosen: Finger[]) {
      if (index === ordered.length) {
        const result: Finger[] = [];
        chosen.forEach((finger, i) => result[ordered[i].index] = finger); assignments.push(result); return;
      }
      for (const finger of fingers) {
        if (ordered[index].fixed !== undefined && finger !== ordered[index].fixed) continue;
        if (index && (passage.hand === 'right' ? finger <= chosen[index - 1] : finger >= chosen[index - 1])) continue;
        enumerate(index + 1, [...chosen, finger]);
      }
    }
    if (ordered.length && ordered.length <= 5 && ordered.every(attack => keyByMidi.has(attack.midi))) enumerate(0, []);
    const result: Candidate[] = [];
    for (const assignment of assignments) {
      let palm = step.attacks.reduce((sum, attack, i) => sum + keyByMidi.get(attack.midi)!.target[0] - fingerPoints(passage.hand, assignment[i], 0)[2][0], 0) / assignment.length;
      if (assignment.length > 1) {
        try {
          palm = planChord(passage.hand, step.attacks.map((attack, i) => ({ finger: assignment[i], midiNote: attack.midi,
            target: keyByMidi.get(attack.midi)!.target })), 0.018, 0.01).position[0];
        } catch { continue; }
      }
      let cost = 0;
      step.attacks.forEach((attack, i) => {
        const finger = assignment[i];
        cost += finger === 4 ? 0.12 : finger === 5 ? 0.18 : 0;
        if (keyByMidi.get(attack.midi)!.black) cost += finger === 1 ? 1.1 : finger === 5 ? 0.7 : 0;
      });
      for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i], b = ordered[j];
        const distance = Math.abs(keyByMidi.get(b.midi)!.target[0] - keyByMidi.get(a.midi)!.target[0]) / WIDTH;
        const fingerDistance = Math.abs(assignment[b.index] - assignment[a.index]);
        cost += Math.max(0, distance - fingerDistance - (assignment[a.index] === 1 || assignment[b.index] === 1 ? 1.5 : 0.25)) ** 2 * 0.8;
      }
      result.push({ fingers: assignment, palm, cost });
    }
    cache.set(cacheKey, result);
    return result;
  }

  function transition(passage: FingeringPassage, index: number, previous: Candidate, next: Candidate): number {
    const before = passage.steps[index - 1], after = passage.steps[index];
    const interval = after.time - before.time;
    if (!(interval > 0)) return Infinity;
    // Every still-held contact reserves its finger. This includes slur overlaps.
    for (const [i, a] of before.attacks.entries()) for (const [j, b] of after.attacks.entries()) {
      if (before.time + a.duration > after.time + 1e-7 && previous.fingers[i] === next.fingers[j] && a.midi !== b.midi) return Infinity;
    }
    const gap = after.time - Math.max(...before.attacks.map(attack => before.time + attack.duration));
    const freedom = Math.min(1, Math.max(0, gap) / 0.22);
    const movement = Math.abs(next.palm - previous.palm) / WIDTH;
    let cost = movement ** 1.3 * (1 - freedom * 0.8) * 0.55;
    if (before.attacks.length === 1 && after.attacks.length === 1) {
      const a = before.attacks[0], b = after.attacks[0], from = previous.fingers[0], to = next.fingers[0];
      const distance = (b.midi - a.midi) * (passage.hand === 'right' ? 1 : -1);
      const crossing = distance * (to - from) < 0;
      if (a.midi === b.midi) cost += from === to ? 0 : 0.45;
      else if (from === to) cost += 2.5 * (1 - freedom);
      if (crossing) {
        if (from === 1 || to === 1) {
          const outer = Math.max(from, to);
          cost += (outer === 5 ? 4 : outer === 2 ? 1.4 : outer === 3 ? 0.65 : 0.85) * (1 - freedom);
          if (Math.abs(distance) > 5) cost += 2;
        } else cost += 5 * (1 - freedom);
      }
      // Quick repetition needs enough time to reset even if the pitch is unchanged.
      if (a.midi === b.midi && from === to && interval < 0.14) cost += (0.14 - interval) * 14;
    }
    if (movement > 3 && interval < 0.25) cost += (movement - 3) * (0.25 - interval) * 12;
    return cost;
  }

  function unwind(path: Path) {
    const result: Path[] = [];
    for (let node: Path | undefined = path; node; node = node.previous) result.push(node);
    return result.reverse();
  }

  /** Bounded beam search; failed validation is a search/model limitation, not a
   * claim that a passage is impossible for a human pianist. No score is mutated. */
  export function calculate(passage: FingeringPassage, progress: (value: FingeringProgress) => void = () => {}): FingeringResult {
    if (!passage.steps.length) return { candidates: [], issues: [{ message: 'No attacks to assign.' }] };
    if (passage.steps.length > 4096) return { candidates: [], issues: [{ message: 'Select a shorter range (up to 4096 attacks per calculation).' }] };
    let beam: Path[] = [];
    const cache = new Map<string, Candidate[]>();
    for (const [index, step] of passage.steps.entries()) {
      progress({ phase: 'search', completed: index, total: passage.steps.length });
      const available = candidates(passage, step, cache);
      if (!available.length) return { candidates: [], issues: [{ message: `${step.label}: no chord fingering satisfies the fixed fingers and this hand model's reach/order limits.`, noteId: step.attacks[0]?.targets[0]?.noteId }] };
      const expanded: Path[] = [];
      for (const candidate of available) {
        if (!index) expanded.push({ candidate, cost: candidate.cost, stepCost: candidate.cost });
        else for (const previous of beam) {
          const stepCost = transition(passage, index, previous.candidate, candidate) + candidate.cost;
          if (Number.isFinite(stepCost)) expanded.push({ candidate, previous, cost: previous.cost + stepCost, stepCost });
        }
      }
      expanded.sort((a, b) => a.cost - b.cost);
      // Keep alternatives for each pair of recent positions, rather than letting
      // cheap identical endings crowd out paths needed by a later fixed finger.
      const counts = new Map<string, number>();
      beam = expanded.filter(path => {
        const key = `${path.previous?.candidate.fingers.join('') ?? ''}/${path.candidate.fingers.join('')}`;
        const count = counts.get(key) ?? 0; counts.set(key, count + 1); return count < 3;
      }).slice(0, beamWidth);
      if (!beam.length) return { candidates: [], issues: [{ message: `${step.label}: no candidate in the bounded search can continue without reusing a held finger. Check the fixed fingers or select a shorter range.`, noteId: step.attacks[0]?.targets[0]?.noteId }] };
    }
    const attempts = beam.slice(0, validationLimit);
    let lastError = '';
    for (const [attempt, path] of attempts.entries()) {
      progress({ phase: 'validate', completed: attempt, total: attempts.length });
      const sequence = unwind(path), notes: Note[] = [];
      const assignments: FingeringAssignment[] = [], warnings: FingeringIssue[] = [];
      for (const [index, node] of sequence.entries()) {
        const step = passage.steps[index];
        step.attacks.forEach((attack, i) => {
          const finger = node.candidate.fingers[i];
          notes.push({ time: step.time, duration: attack.duration, midiNote: attack.midi, hand: passage.hand, finger, voice: 'selected' });
          for (const target of attack.targets) if (target.fixed === undefined) assignments.push({ noteId: target.noteId, pitchIndex: target.pitchIndex, finger });
        });
        if (node.stepCost >= 4) warnings.push({ message: `${step.label}: a large hand movement, stretch or finger crossing needs review.`, noteId: step.attacks[0].targets[0].noteId });
      }
      try {
        const validated = validate(notes);
        preparePerformance(validated);
        if (assignments.length !== passage.missing) throw new Error('The draft does not cover every unassigned pitch.');
        return { candidates: [{ assignments, warnings, cost: path.cost }], issues: [] };
      } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    }
    return { candidates: [], issues: [{ message: `No candidate passed animation validation within the search limit. This does not mean the passage is unplayable. Try adjusting fixed fingers or selecting a shorter range. ${lastError}` }] };
  }
}
export default AutomaticFingering;
