import ScoreTempo from './score-tempo.ts';
import MusicalTime from '../theory/musical-time.ts';
import ScoreTimeline from './score-timeline.ts';
import ScoreHairpins from './score-hairpins.ts';
import type { DynamicLevel, ScoreProject } from './types.ts';

namespace ScoreDynamics {
  export const levels: readonly DynamicLevel[] = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
  export const defaultLevel: DynamicLevel = 'mf';
  export const defaultVelocities: Record<DynamicLevel, number> = { ppp: 48, pp: 62, p: 75, mp: 82, mf: 88, f: 98, ff: 108, fff: 118 };
  export function isVelocity(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 127; }
  export function velocityAt(project: ScoreProject, position: number): number {
    return createVelocityLookup(project)(position);
  }

  type DynamicProject = Pick<ScoreProject, 'outline' | 'dynamicChanges' | 'hairpins'>;

  export function resolveHairpins(project: DynamicProject, marks = changes(project)) {
    if (!project.hairpins?.length) return [];
    const markVelocities = new Map(marks.map(mark => [mark.position, mark.velocity]));
    let markIndex = 0;
    let velocity = defaultVelocities[defaultLevel];
    return ScoreHairpins.ranges(project).map(range => {
      while (markIndex < marks.length && marks[markIndex].position <= range.start) {
        velocity = marks[markIndex++].velocity;
      }
      const startVelocity = velocity;
      const endMarkVelocity = markVelocities.get(range.end);
      const endVelocity = endMarkVelocity ?? range.hairpin.endVelocity ?? startVelocity;
      const hasInteriorMark = markIndex < marks.length && marks[markIndex].position < range.end;
      velocity = endVelocity;
      return { ...range, startVelocity, endVelocity, endMarkVelocity, hasInteriorMark };
    });
  }

  export function hasValidHairpins(project: DynamicProject): boolean {
    if (!project.hairpins?.length) return true;
    return resolveHairpins(project).every(({ hairpin, endMarkVelocity, hasInteriorMark }) =>
      !hasInteriorMark && (endMarkVelocity === undefined || hairpin.endVelocity === undefined));
  }

  /** Preserve the previous mark's value when an edit detaches a surviving endpoint. */
  export function reconcileHairpins(before: ScoreProject, after: ScoreProject): ScoreProject | undefined {
    if (!after.hairpins?.length) return after;
    const ranges = resolveHairpins(after);
    if (ranges.some(range => range.hasInteriorMark)) return undefined;
    const previousMarks = new Map(before.hairpins?.length
      ? resolveHairpins(before).map(({ hairpin, endMarkVelocity }) => [hairpin.id, endMarkVelocity]) : []);
    let changed = false;
    const endVelocities = new Map(ranges.map(({ hairpin, endMarkVelocity }) => [hairpin.id, endMarkVelocity === undefined
      ? previousMarks.get(hairpin.id) ?? hairpin.endVelocity : undefined]));
    const hairpins = after.hairpins.map(hairpin => {
      const endVelocity = endVelocities.get(hairpin.id);
      if (endVelocity === hairpin.endVelocity) return hairpin;
      changed = true;
      const { endVelocity: previousEndVelocity, ...range } = hairpin;
      return endVelocity === undefined ? range : { ...range, endVelocity };
    });
    return changed ? { ...after, hairpins } : after;
  }

  export function createVelocityLookup(project: DynamicProject) {
    type Point = { position: number; velocity: number; order: number; target?: { position: number; velocity: number } };
    const marks = changes(project);
    const points: Point[] = marks.map(({ position, velocity }) => ({ position, velocity, order: 1 }));
    for (const { start, end, startVelocity, endVelocity } of resolveHairpins(project, marks)) {
      if (startVelocity === endVelocity) continue;
      points.push({ position: start, velocity: startVelocity, order: 2,
        target: { position: end, velocity: endVelocity } });
      points.push({ position: end, velocity: endVelocity, order: 0 });
    }
    points.sort((a, b) => a.position - b.position || a.order - b.order);
    return (position: number): number => {
      let low = 0, high = points.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (points[middle].position <= position + 1e-8) low = middle + 1;
        else high = middle;
      }
      const point = points[low - 1];
      if (!point) return defaultVelocities[defaultLevel];
      if (!point.target) return point.velocity;
      const fraction = Math.max(0, (position - point.position) / (point.target.position - point.position));
      return Math.round(point.velocity + (point.target.velocity - point.velocity) * fraction);
    };
  }
  export const anchors = ScoreTempo.anchors;
  export function isLevel(level: unknown): level is DynamicLevel {
    return typeof level === 'string' && levels.includes(level as DynamicLevel);
  }
  export function changes(project: ScoreProject) {
    if (!project.dynamicChanges?.length) return [];
    const byId = ScoreTimeline.isPrepared(project.outline) ? undefined : new Map(anchors(project).map(anchor => [anchor.noteId, anchor]));
    return (project.dynamicChanges ?? []).flatMap(change => {
      const anchor = byId ? byId.get(change.noteId) : ScoreTempo.anchor(project, change.noteId);
      return anchor && isLevel(change.level) && isVelocity(change.velocity) ? [{ ...anchor, level: change.level, velocity: change.velocity }] : [];
    }).sort((a, b) => MusicalTime.compareNumbers(a.position, b.position));
  }
  export function isValid(project: ScoreProject): boolean {
    const saved = project.dynamicChanges ?? [];
    return new Set(saved.map(change => change.noteId)).size === saved.length && changes(project).length === saved.length;
  }
  /** Includes simultaneous attacks on every staff and voice; held pitches are not retriggered. */
  export function at(project: ScoreProject, position: number): DynamicLevel {
    let level = defaultLevel;
    for (const change of changes(project)) {
      if (MusicalTime.compareNumbers(change.position, position) > 0) break;
      level = change.level;
    }
    return level;
  }
  export function set(project: ScoreProject, noteId: string, level: DynamicLevel | null, velocity?: number): ScoreProject {
    if (!anchors(project).some(anchor => anchor.noteId === noteId) || (level !== null && (!isLevel(level) || !isVelocity(velocity)))) return project;
    const dynamicChanges = (project.dynamicChanges ?? []).filter(change => change.noteId !== noteId);
    if (level !== null) dynamicChanges.push({ noteId, level, velocity: velocity! });
    return { ...project, dynamicChanges };
  }
  /** Movement follows IDs. Deleting/resting an anchor removes its change without copying it. */
  export function reconcile(project: ScoreProject): ScoreProject {
    return project.dynamicChanges ? { ...project, dynamicChanges: changes(project).map(({ noteId, level, velocity }) => ({ noteId, level, velocity })) } : project;
  }
}
export default ScoreDynamics;
