<script lang="ts">
  import { onMount } from 'svelte';
  import type { Hairpin } from '../domain/score/types.ts';
  import './expression-dialog.css';

  let { hairpin, baseVelocity, apply, cancel }: {
    hairpin: Hairpin;
    baseVelocity: number;
    apply: (kind: Hairpin['kind'], velocities: Hairpin['velocities']) => void;
    cancel: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  let list: HTMLDivElement;
  let row = $state(0);
  let kind = $state<Hairpin['kind']>('crescendo');
  let start = $state(0);
  let end = $state(0);
  const labels = ['Notation', 'Start velocity', 'End velocity'];
  const values = $derived([kind === 'crescendo' ? 'Crescendo (<)' : 'Decrescendo (>)', start, end]);

  onMount(() => {
    kind = hairpin.kind;
    start = hairpin.velocities?.start ?? baseVelocity;
    end = hairpin.velocities?.end ?? baseVelocity;
    dialog.showModal();
    list.focus();
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const key = event.key;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      row = Math.max(0, Math.min(labels.length - 1, row + (key === 'ArrowUp' ? -1 : 1)));
    } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const delta = key === 'ArrowLeft' ? -1 : 1;
      if (row === 0) kind = delta < 0 ? 'crescendo' : 'decrescendo';
      else if (row === 1) start = Math.max(1, Math.min(127, start + delta));
      else end = Math.max(1, Math.min(127, end + delta));
    } else if (key === 'Enter' && !event.repeat) {
      const inherited = !hairpin.velocities && start === baseVelocity && end === baseVelocity;
      apply(kind, inherited ? undefined : { start, end });
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
      <div id={`hairpin-row-${index}`} role="option" aria-selected={row === index} class="expression-row" class:active={row === index}>
        <span>{label}</span><span class="expression-value">{values[index]}</span>
      </div>
    {/each}
  </div>
  <footer><kbd>↑↓</kbd> Select <span>·</span> <kbd>←→</kbd> Edit <span>·</span> <kbd>Enter</kbd> Apply <span>·</span> <kbd>Esc</kbd> Cancel</footer>
</dialog>

<style>
  .hairpin-content { background: #f3f7f7; padding: 12px; outline: none; }
</style>
