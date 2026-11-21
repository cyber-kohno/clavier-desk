<script lang="ts">
  import { onMount } from 'svelte';
  import type { Hairpin } from '../domain/score/types.ts';
  import './expression-dialog.css';

  let { hairpin, startVelocity, endMarkVelocity, apply, cancel }: {
    hairpin: Hairpin;
    startVelocity: number;
    endMarkVelocity?: number;
    apply: (kind: Hairpin['kind'], endVelocity?: number) => void;
    cancel: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  let list: HTMLDivElement;
  let row = $state(0);
  let kind = $state<Hairpin['kind']>('crescendo');
  let endVelocity = $state<number>();
  const displayedEnd = $derived(endMarkVelocity ?? endVelocity ?? startVelocity);
  const endLocked = $derived(endMarkVelocity !== undefined);
  const labels = ['Notation', 'Start velocity', 'End velocity'];
  const values = $derived([kind === 'crescendo' ? 'Crescendo (<)' : 'Decrescendo (>)', startVelocity, displayedEnd]);

  onMount(() => {
    kind = hairpin.kind;
    endVelocity = hairpin.endVelocity;
    dialog.showModal();
    list.focus();
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const key = event.key;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      row = key === 'ArrowDown' && !endLocked ? 2 : 0;
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const delta = key === 'ArrowLeft' ? -1 : 1;
      if (row === 0) kind = delta < 0 ? 'crescendo' : 'decrescendo';
      else if (!endLocked) {
        const nextEnd = Math.max(1, Math.min(127, displayedEnd + delta));
        if (nextEnd !== displayedEnd) endVelocity = nextEnd;
      }
    } else if (key === 'Enter' && !event.repeat) {
      apply(kind, endLocked ? undefined : endVelocity);
    } else if (key === 'Escape' && !event.repeat) {
      cancel();
    }
  }
</script>

<dialog class="expression-modal" bind:this={dialog} aria-labelledby="hairpin-title" aria-describedby="hairpin-context"
  oncancel={(event) => { event.preventDefault(); cancel(); }}>
  <header>
    <h2 id="hairpin-title">Hairpin Settings</h2>
    <p id="hairpin-context">Both staves · All voices</p>
  </header>
  <div class="expression-list hairpin-content" role="listbox" aria-label="Hairpin settings"
    aria-activedescendant={`hairpin-row-${row}`} tabindex="0" bind:this={list} onkeydown={handleKeydown}>
    {#each labels as label, index (label)}
      {@const fixed = index === 1 || (index === 2 && endLocked)}
      <div id={`hairpin-row-${index}`} role="option" aria-selected={row === index} aria-disabled={fixed || undefined}
        class="expression-row" class:active={row === index}>
        <span>{label}{fixed ? ' · Fixed' : ''}</span><span class="expression-value">{values[index]}</span>
      </div>
    {/each}
  </div>
  <footer><kbd>↑↓</kbd> Select <span>·</span> <kbd>←→</kbd> Edit <span>·</span> <kbd>Enter</kbd> Apply <span>·</span> <kbd>Esc</kbd> Cancel</footer>
</dialog>

<style>
  .hairpin-content { background: #f3f7f7; padding: 12px; outline: none; }
</style>
