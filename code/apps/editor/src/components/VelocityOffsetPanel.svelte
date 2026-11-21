<script lang="ts">
  import { onMount } from 'svelte';
  import { soundingVelocity } from '../domain/score/pitch-velocity.ts';
  import type { VelocityOffsetDraft } from '../state/velocity-offset-input.ts';

  let { anchor, unadjusted, draft, cancel }: {
    anchor: HTMLElement;
    unadjusted: number | null;
    draft: VelocityOffsetDraft;
    cancel: () => void;
  } = $props();

  let frame = $state<HTMLDivElement>();
  let position = $state({ left: 0, top: 0 });
  const sign = $derived(draft.offset > 0 ? '+' : draft.offset < 0 ? '−' : '±');
  const digits = $derived(String(Math.abs(draft.offset)).padStart(2, '0'));
  const beforeVelocity = $derived(unadjusted === null ? null : soundingVelocity(unadjusted));
  const afterVelocity = $derived(unadjusted === null ? null : soundingVelocity(unadjusted, draft.offset));

  function updatePosition() {
    if (!frame) return;
    if (!anchor.isConnected) { cancel(); return; }
    const rect = anchor.getBoundingClientRect();
    const { offsetWidth, offsetHeight } = frame;
    position = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - offsetWidth - 8)),
      top: rect.bottom + 4 + offsetHeight <= window.innerHeight - 8
        ? rect.bottom + 4 : Math.max(8, rect.top - offsetHeight - 4),
    };
  }

  $effect(updatePosition);

  onMount(() => {
    frame?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (frame && event.target instanceof Node && !frame.contains(event.target)) cancel();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  });
</script>

<div bind:this={frame} class="velocity-panel" role="group" aria-label="Pitch velocity adjustment"
  tabindex="-1" style:left={`${position.left}px`} style:top={`${position.top}px`}>
  <div class="velocities" aria-live="polite">
    {#if beforeVelocity === null}
      <span class="mixed" title="Unadjusted velocities vary across the selection">Mixed</span>
    {:else}
      {beforeVelocity} → <span class:changed={afterVelocity !== beforeVelocity}>{afterVelocity}</span>
    {/if}
  </div>
  <div class="offset">
    <span class:active={draft.column === 'sign'}>{sign}</span><span
      class:active={draft.column === 'tens'}>{digits[0]}</span><span
      class:active={draft.column === 'ones'}>{digits[1]}</span>
  </div>
</div>

<style>
  .velocity-panel {
    position: fixed;
    z-index: 1000;
    display: grid;
    gap: 3px;
    justify-items: center;
    padding: 4px 7px;
    border: 1px solid #ffffffa8;
    border-radius: 3px;
    background: #000;
    color: #fff;
    font: 600 14px/1.35 Consolas, monospace;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    outline: none;
    box-shadow: 0 4px 12px #0008;
  }

  .velocities { min-width: 9ch; text-align: center; }
  .velocities .changed { color: #ffeb3b; }
  .velocities .mixed { color: #7dd3fc; }
  .offset { display: flex; }
  .offset span { padding: 0 3px; border-radius: 2px; }
  .offset .active { background: #fff; color: #000; }
</style>
