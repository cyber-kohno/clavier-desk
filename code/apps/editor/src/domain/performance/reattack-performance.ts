import type { PlaybackEvent } from './score-playback-plan.ts';
import { MIN_REATTACK_GAP_SECONDS } from '../theory/performance-timing.ts';
import Articulation from './articulation-performance.ts';

namespace ReattackPerformance {
  type Attack = { time: number; voice: string };

  function limitKeyHold(event: PlaybackEvent, index: number, duration: number) {
    event.keyHoldLimitsSeconds ??= [...(event.pitchDurationsSeconds ?? event.pitches.map(() => event.durationSeconds))];
    event.keyHoldLimitsSeconds[index] = Math.min(event.keyHoldLimitsSeconds[index], duration);
  }

  function reserveVoiceHandoffs(events: PlaybackEvent[]) {
    const attacks: Record<'left' | 'right', Attack[]> = { left: [], right: [] };
    for (const event of events) {
      const sources = event.performance ?? [];
      for (const source of sources) {
        const hand = attacks[source.hand];
        const previous = hand.at(-1);
        if (previous?.time !== event.startSeconds || previous.voice !== source.voice)
          hand.push({ time: event.startSeconds, voice: source.voice });
      }
    }
    const tolerance = 1e-8;
    function hasHandoff(hand: Attack[], end: number, voice: string) {
      let low = 0, high = hand.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (hand[middle].time < end - tolerance) low = middle + 1;
        else high = middle;
      }
      for (let i = low; i < hand.length && hand[i].time <= end + tolerance; i++)
        if (hand[i].voice !== voice) return true;
      return false;
    }
    for (const event of events) {
      event.performance?.forEach((source, index) => {
        const sounding = event.pitchDurationsSeconds?.[index] ?? event.durationSeconds;
        const hold = Math.min(sounding, event.keyHoldLimitsSeconds?.[index] ?? Infinity);
        const shortened = hold - MIN_REATTACK_GAP_SECONDS;
        // Keep real overlaps and very short attacks. Only an ending contact
        // that meets another voice's onset gets an earlier physical release.
        if (shortened < 0.001 || !hasHandoff(attacks[source.hand], event.startSeconds + hold, source.voice)) return;
        limitKeyHold(event, index, shortened);
      });
    }
  }

  /** Apply after all time warps. Same-voice reattacks can shorten audio.
   * Handoffs between voices only affect physical key hold. */
  export function apply(events: PlaybackEvent[]): PlaybackEvent[] {
    const next = new Map<string, number>();
    const nextKey = new Map<string, Attack & { rollAnchor?: number }>();
    const result = events.map(event => ({ ...event,
      pitchDurationsSeconds: [...(event.pitchDurationsSeconds ?? event.pitches.map(() => event.durationSeconds))],
      ...(event.keyHoldLimitsSeconds ? { keyHoldLimitsSeconds: [...event.keyHoldLimitsSeconds] } : {}),
    }));
    for (let i = result.length - 1; i >= 0; i--) {
      const event = result[i];
      event.pitches.forEach((midi, index) => {
        const identity = event.performance?.[index];
        if (!identity) return;
        const key = JSON.stringify([identity.hand, identity.voice, midi]);
        const sharedKey = JSON.stringify([identity.hand, midi]);
        const reattack = nextKey.get(sharedKey);
        const onset = next.get(key);
        if (onset !== undefined && onset > event.startSeconds) {
          const interval = onset - event.startSeconds;
          const gap = Math.max(MIN_REATTACK_GAP_SECONDS, interval * Articulation.defaults.unslurredGapRatio);
          const available = interval - gap;
          // Do not manufacture a zero/negative hold or move an onset to hide an
          // unrepresentable repetition. Existing motion validation will reject it.
          if (available >= 0.001) event.pitchDurationsSeconds[index] = Math.min(event.pitchDurationsSeconds[index], available);
        }
        // A rolled attack can lead its written onset and meet the same key
        // from a different voice. Reserve release only for notes ending at
        // or before the roll anchor, leaving true sustained conflicts visible.
        if (reattack?.rollAnchor !== undefined && reattack.voice !== identity.voice) {
          const hold = Math.min(event.pitchDurationsSeconds[index], event.keyHoldLimitsSeconds?.[index] ?? Infinity);
          const available = reattack.time - event.startSeconds - MIN_REATTACK_GAP_SECONDS;
          if (available >= 0.001 && hold > available && event.startSeconds + hold <= reattack.rollAnchor + 1e-8)
            limitKeyHold(event, index, available);
        }
        next.set(key, event.startSeconds);
        nextKey.set(sharedKey, { time: event.startSeconds, voice: identity.voice, rollAnchor: event.rollAnchorSeconds });
      });
      event.durationSeconds = Math.max(...event.pitchDurationsSeconds);
    }
    reserveVoiceHandoffs(result);
    return result;
  }
}
export default ReattackPerformance;
