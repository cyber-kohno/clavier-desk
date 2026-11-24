export function glissandoEndpointLabel({ start, end }: { start?: true; end?: true }): string {
  return start && end ? 'Gl. E / S' : start ? 'Gl. S' : 'Gl. E';
}

export function glissandoPath(x1: number, y1: number, x2: number, y2: number, wavy: boolean): string {
  const start = `M ${x1} ${y1}`;
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (!wavy || length < 5) return `${start} L ${x2} ${y2}`;
  const count = Math.max(2, Math.round(length / 4));
  const nx = -(y2 - y1) / length * 2, ny = (x2 - x1) / length * 2;
  const segments = Array.from({ length: count }, (_, index) => {
    const at = (index + 1) / count, middle = (index + 0.5) / count;
    const side = index % 2 ? -1 : 1;
    return `Q ${x1 + (x2 - x1) * middle + nx * side} ${y1 + (y2 - y1) * middle + ny * side} ${x1 + (x2 - x1) * at} ${y1 + (y2 - y1) * at}`;
  });
  return [start, ...segments].join(' ');
}
