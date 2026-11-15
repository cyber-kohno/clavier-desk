export type CameraInput = { horizontal: number; vertical: number; rotate: boolean; zoom: number };
type Key = Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>;
type Action = 'left' | 'right' | 'up' | 'down' | 'in' | 'out';

/** Physical held keys drive the render clock, independently of OS key repeat. */
export function createAnimationCameraKeyboard() {
  const held = new Map<string, Action>();
  let shift = false;
  return {
    press(event: Key) {
      shift = event.shiftKey;
      const action: Action | undefined = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
        '+': 'in', '=': 'in', '-': 'out', '_': 'out' } as Record<string, Action>)[event.key]
        ?? (event.code === 'NumpadAdd' ? 'in' : event.code === 'NumpadSubtract' ? 'out' : undefined);
      if (!action) return false;
      held.set(event.code || event.key, action);
      return true;
    },
    release(event: Key) { held.delete(event.code || event.key); shift = event.shiftKey; },
    reset() { held.clear(); shift = false; },
    input(): CameraInput {
      const actions = new Set(held.values());
      return { horizontal: Number(actions.has('right')) - Number(actions.has('left')),
        vertical: Number(actions.has('up')) - Number(actions.has('down')), rotate: shift,
        zoom: Number(actions.has('in')) - Number(actions.has('out')) };
    },
  };
}
