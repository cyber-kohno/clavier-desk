import { getSelectedOutlineBlocks, type OutlineCursor } from './outline-cursor.ts';
import type { OutlineBlock } from '../domain/score/types.ts';
import type { AnimationRange } from '../domain/performance/animation-range.ts';

namespace AnimationSelection {
  export function resolve(outline: readonly OutlineBlock[], cursor: OutlineCursor, mode: 'outline' | 'timeline'):
    { range: AnimationRange | null; error?: string } {
    if (mode !== 'outline' || cursor.selectionAnchorBlockId === undefined) return { range: null };
    const selected = getSelectedOutlineBlocks(outline, cursor);
    const measures = selected.filter(block => block.type === 'measure');
    if (!measures.length) return { range: null, error: 'Select at least one measure block for a partial animation.' };
    return { range: { firstMeasureId: measures[0].id, lastMeasureId: measures.at(-1)!.id } };
  }
}
export default AnimationSelection;
