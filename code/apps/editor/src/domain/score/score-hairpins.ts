import MusicalTime from '../theory/musical-time.ts';
import ScoreTimeline from './score-timeline.ts';
import type { Hairpin, HairpinAnchor, ScoreProject } from './types.ts';

type HairpinProject = Pick<ScoreProject, 'outline' | 'hairpins'>;
type HairpinEndpoint = 'start' | 'end';

namespace ScoreHairpins {
  function anchorAt(index: ReturnType<typeof ScoreTimeline.index>, endpoint: HairpinEndpoint, position: number): HairpinAnchor | undefined {
    const entry = endpoint === 'start'
      ? index.measureAt(position)
      : index.measures.find(measure => position > measure.startSixteenths && position <= measure.startSixteenths + measure.lengthSixteenths);
    return entry && { measureId: entry.measure.id, offset: MusicalTime.fromNumber(position - entry.startSixteenths) };
  }

  export function ranges(project: HairpinProject) {
    if (!project.hairpins?.length) return [];
    const measures = new Map(ScoreTimeline.index(project.outline).measures.map(entry => [entry.measure.id, entry]));
    function resolve(anchor: HairpinAnchor) {
      const measure = measures.get(anchor.measureId);
      const offset = MusicalTime.toNumber(anchor.offset);
      return measure && offset >= 0 && offset <= measure.lengthSixteenths
        ? MusicalTime.addNumbers(measure.startSixteenths, offset) : undefined;
    }
    return project.hairpins.flatMap(hairpin => {
      const start = resolve(hairpin.start), end = resolve(hairpin.end);
      return start !== undefined && end !== undefined && MusicalTime.compareNumbers(start, end) < 0
        ? [{ hairpin, start, end }] : [];
    }).sort((a, b) => a.start - b.start);
  }

  export function at(project: HairpinProject, position: number) {
    const rangesInOrder = ranges(project);
    return rangesInOrder.find(range => position >= range.start && position < range.end)
      ?? rangesInOrder.find(range => position === range.end);
  }

  export function canStartAt(project: HairpinProject, position: number): boolean {
    if (!ScoreTimeline.index(project.outline).measureAt(position)) return false;
    const range = at(project, position);
    return !range || position === range.end;
  }

  export function add(project: ScoreProject, start: number, end: number): ScoreProject {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return project;
    const index = ScoreTimeline.index(project.outline);
    if (start < 0 || end > index.length || ranges(project).some(range => start < range.end && end > range.start)) return project;
    const first = anchorAt(index, 'start', start);
    const last = anchorAt(index, 'end', end);
    if (!first || !last) return project;
    const hairpin: Hairpin = {
      id: `hairpin-${crypto.randomUUID()}`,
      start: first,
      end: last,
      kind: 'crescendo',
    };
    return { ...project, hairpins: [...(project.hairpins ?? []), hairpin] };
  }

  export function moveEndpoint(project: ScoreProject, endpoint: HairpinEndpoint, position: number): ScoreProject {
    if (!Number.isFinite(position)) return project;
    const ordered = ranges(project);
    // Include the opposite endpoint so an edit there cannot reach across to another range.
    const range = endpoint === 'start'
      ? ordered.find(range => range.end >= position)
      : ordered.reverse().find(range => range.start <= position);
    if (!range || position === range[endpoint]) return project;
    if (endpoint === 'start' ? position >= range.end : position <= range.start) return project;

    const anchor = anchorAt(ScoreTimeline.index(project.outline), endpoint, position);
    if (!anchor) return project;
    return { ...project, hairpins: project.hairpins!.map(hairpin =>
      hairpin === range.hairpin ? { ...hairpin, [endpoint]: anchor } : hairpin) };
  }

  export function configure(project: ScoreProject, id: string, kind: Hairpin['kind'], endVelocity?: number): ScoreProject {
    const current = project.hairpins?.find(hairpin => hairpin.id === id);
    if (!current || (current.kind === kind && current.endVelocity === endVelocity)) return project;
    const { endVelocity: previousEndVelocity, ...range } = current;
    const configured = endVelocity === undefined ? { ...range, kind } : { ...range, kind, endVelocity };
    return { ...project, hairpins: project.hairpins!.map(hairpin => hairpin === current ? configured : hairpin) };
  }

  export function remove(project: ScoreProject, position: number): ScoreProject {
    const range = at(project, position);
    return range ? { ...project, hairpins: project.hairpins!.filter(hairpin => hairpin.id !== range.hairpin.id) } : project;
  }

  function validRanges(project: HairpinProject) {
    const ids = new Set<string>();
    let lastEnd = -1;
    return ranges(project).filter(({ hairpin, start, end }) => {
      if (ids.has(hairpin.id) || start < lastEnd) return false;
      ids.add(hairpin.id);
      lastEnd = end;
      return true;
    });
  }

  export function isValid(project: HairpinProject): boolean {
    return validRanges(project).length === (project.hairpins?.length ?? 0);
  }

  export function reconcile(project: ScoreProject): ScoreProject {
    if (!project.hairpins?.length) return project;
    const retained = validRanges(project);
    if (retained.length === project.hairpins.length) return project;
    const hairpins = new Set(retained.map(range => range.hairpin));
    return { ...project, hairpins: project.hairpins.filter(hairpin => hairpins.has(hairpin)) };
  }
}

export default ScoreHairpins;
