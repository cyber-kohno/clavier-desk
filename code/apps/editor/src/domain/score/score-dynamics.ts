import ScoreTempo from './score-tempo.ts';
import MusicalTime from '../theory/musical-time.ts';
import ScoreTimeline from './score-timeline.ts';
import ScoreHairpins from './score-hairpins.ts';
import type { DynamicLevel, HairpinAnchor, ScoreProject } from './types.ts';

namespace ScoreDynamics {
  export const levels: readonly DynamicLevel[] = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
  export const defaultLevel: DynamicLevel = 'mf';
  export const defaultVelocities: Record<DynamicLevel, number> = { ppp: 48, pp: 62, p: 75, mp: 82, mf: 88, f: 98, ff: 108, fff: 118 };
  export function isVelocity(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 127; }
  export function velocityAt(project: ScoreProject, position: number): number {
    return createVelocityLookup(project)(position);
  }

  export function initialHairpinVelocities(project: ScoreProject, start: number, end: number): { start: number; end: number } | undefined {
    const endMark = changes(project).reverse().find(mark => MusicalTime.compareNumbers(mark.position, end) === 0);
    if (endMark) return { start: velocityAt(project, start), end: endMark.velocity };
  }

  type DynamicProject = Pick<ScoreProject, 'outline' | 'dynamicChanges' | 'hairpins'>;

  function hairpinMarkUsage(project: DynamicProject) {
    const marks = changes(project);
    return ScoreHairpins.ranges(project).map(({ hairpin, start, end }) => ({
      hairpin,
      interiorMarks: marks.filter(mark => mark.position > start && mark.position < end).map(mark => mark.noteId),
    }));
  }

  function sameAnchor(a: HairpinAnchor, b: HairpinAnchor): boolean {
    return a.measureId === b.measureId && MusicalTime.compare(a.offset, b.offset) === 0;
  }

  export function preservesHairpinMarkRules(before: DynamicProject, after: DynamicProject): boolean {
    if (!after.hairpins?.length || !after.dynamicChanges?.length || (before.hairpins === after.hairpins &&
      before.outline === after.outline && before.dynamicChanges === after.dynamicChanges)) return true;
    const invalid = hairpinMarkUsage(after).filter(range => range.interiorMarks.length);
    if (!invalid.length) return true;

    // Keep legacy ranges editable without allowing a resize or a new violation.
    const previous = new Map(hairpinMarkUsage(before).map(range => [range.hairpin.id, range]));
    return invalid.every(range => {
      const old = previous.get(range.hairpin.id);
      return old && sameAnchor(old.hairpin.start, range.hairpin.start) && sameAnchor(old.hairpin.end, range.hairpin.end) &&
        range.interiorMarks.every(noteId => old.interiorMarks.includes(noteId));
    });
  }

  /** An immediate dynamic inside a hairpin becomes a shared endpoint of two segments. */
  export function hairpinSegments(project: DynamicProject, marks = changes(project)) {
    return ScoreHairpins.ranges(project).flatMap(({ hairpin, start, end }) => {
      const points = [
        { position: start, velocity: hairpin.velocities?.start },
        ...marks.filter(mark => mark.position > start && mark.position < end),
        { position: end, velocity: hairpin.velocities?.end },
      ];
      return points.slice(1).map((point, index) => ({ hairpin, start: points[index], end: point }));
    });
  }

  export function createVelocityLookup(project: DynamicProject) {
    type Point = { position: number; velocity: number; order: number; target?: { position: number; velocity: number } };
    const marks = changes(project);
    const points: Point[] = marks.map(({ position, velocity }) => ({ position, velocity, order: 1 }));
    for (const { hairpin, start, end } of hairpinSegments(project, marks)) {
      if (!hairpin.velocities || start.velocity === undefined || end.velocity === undefined) continue;
      points.push({ position: start.position, velocity: start.velocity, order: 2,
        target: { position: end.position, velocity: end.velocity } });
      points.push({ position: end.position, velocity: end.velocity, order: 0 });
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
