import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { PreviewHairpin } from '../musicxml/preview-musicxml.ts';
import PreviewPedals from './preview-pedals.ts';

namespace PreviewHairpins {
  /** Use score-time anchors for endpoints between notes and in full-measure rests. */
  export function draw(svg: SVGSVGElement, renderer: OpenSheetMusicDisplay, hairpins: PreviewHairpin[]) {
    if (!hairpins.length) return;
    const layouts = PreviewPedals.measureLayouts(renderer);
    const ns = 'http://www.w3.org/2000/svg';
    const group = document.createElementNS(ns, 'g');
    group.setAttribute('class', 'score-preview-hairpins');
    group.setAttribute('aria-label', 'Crescendo and decrescendo marks');
    group.setAttribute('fill', 'none');
    group.setAttribute('stroke', '#111');
    group.setAttribute('stroke-width', '1.2');
    for (const { start, end } of hairpins) {
      const [upper, lower] = renderer.GraphicSheet.MeasureList[start.measureOffset];
      if (!upper || !lower) continue;
      const upperBottom = upper.ParentStaffLine.PositionAndShape.AbsolutePosition.y + 4;
      const lowerTop = lower.ParentStaffLine.PositionAndShape.AbsolutePosition.y;
      const y = (upperBottom + lowerTop) * 5;
      const x1 = PreviewPedals.xAt(layouts[start.measureOffset], start.position);
      const x2 = Math.max(x1, PreviewPedals.xAt(layouts[end.measureOffset], end.position));
      const opening1 = start.opening * 5, opening2 = end.opening * 5;
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', `M ${x1} ${y - opening1} L ${x2} ${y - opening2} M ${x1} ${y + opening1} L ${x2} ${y + opening2}`);
      group.append(path);
    }
    svg.append(group);
  }
}

export default PreviewHairpins;
