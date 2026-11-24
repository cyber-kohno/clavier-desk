import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { PreviewGlissando, PreviewGlissandoLabel } from '../musicxml/preview-musicxml.ts';
import { glissandoEndpointLabel, glissandoPath } from './glissando-line.ts';

const svgNS = 'http://www.w3.org/2000/svg';

function notePosition(renderer: OpenSheetMusicDisplay, target: PreviewGlissando['start']) {
  const measure = renderer.GraphicSheet.MeasureList[target.measureOffset]?.[target.staffIndex];
  for (const entry of measure?.staffEntries ?? []) for (const voice of entry.graphicalVoiceEntries) {
    const notes = voice.notes.filter(note => {
      const source = note.sourceNote.ParentVoiceEntry;
      return !source.IsGrace && source.ParentVoice.VoiceId === target.voiceNumber &&
        Math.abs(source.Timestamp.RealValue * 16 - target.position) < 1e-8;
    }).sort((a, b) => b.sourceNote.halfTone - a.sourceNote.halfTone);
    const note = notes[target.pitchIndex];
    if (!note) continue;
    const point = note.PositionAndShape.AbsolutePosition;
    return { x: point.x * 10, y: point.y * 10 };
  }
}

export function drawGlissandi(svg: SVGSVGElement, renderer: OpenSheetMusicDisplay, spans: PreviewGlissando[],
    labels: PreviewGlissandoLabel[]) {
  if (!spans.length && !labels.length) return;
  const layer = document.createElementNS(svgNS, 'g');
  layer.setAttribute('class', 'preview-glissandi');
  for (const span of spans) {
    const from = notePosition(renderer, span.start), to = notePosition(renderer, span.end);
    if (!from || !to || to.x <= from.x) continue;
    const x1 = from.x + Math.min(10, (to.x - from.x) / 4);
    const x2 = to.x - Math.min(5, (to.x - from.x) / 4);
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', glissandoPath(x1, from.y, x2, to.y, span.lineType === 'wavy'));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#111');
    path.setAttribute('stroke-width', '1.15');
    if (span.lineType === 'dashed' || span.lineType === 'dotted')
      path.setAttribute('stroke-dasharray', span.lineType === 'dashed' ? '4 3' : '1 2');
    layer.append(path);
    if (span.text) {
      const text = document.createElementNS(svgNS, 'text');
      const x = (x1 + x2) / 2, y = (from.y + to.y) / 2;
      const angle = Math.atan2(to.y - from.y, x2 - x1) * 180 / Math.PI;
      text.setAttribute('transform', `translate(${x} ${y}) rotate(${angle})`);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('y', '-4');
      text.setAttribute('font-size', '10');
      text.setAttribute('font-style', 'italic');
      text.textContent = span.text;
      layer.append(text);
    }
  }
  if (layer.querySelectorAll('path').length === spans.length)
    svg.querySelectorAll('g.vf-glissando').forEach(group => group.remove());
  for (const label of labels) {
    const position = notePosition(renderer, label.target);
    if (!position) continue;
    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', String(position.x));
    text.setAttribute('y', String(position.y - 14));
    text.setAttribute('fill', '#14789d');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '10');
    text.setAttribute('font-weight', '600');
    text.textContent = glissandoEndpointLabel(label);
    layer.append(text);
  }
  svg.append(layer);
}
