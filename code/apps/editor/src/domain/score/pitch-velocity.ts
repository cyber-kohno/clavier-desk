import type { PianoPitch } from './types.ts';

export const maxVelocityOffset = 50;

export function isVelocityOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= maxVelocityOffset;
}

export function soundingVelocity(unadjusted: number, offset = 0): number {
  return Math.max(1, Math.min(127, unadjusted + offset));
}

export function withVelocityOffset(pitch: PianoPitch, offset: number): PianoPitch {
  if (offset === 0) {
    if (pitch.velocityOffset === undefined) return pitch;
    const { velocityOffset: _previous, ...rest } = pitch;
    return rest;
  }
  return pitch.velocityOffset === offset ? pitch : { ...pitch, velocityOffset: offset };
}
