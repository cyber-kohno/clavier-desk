<script lang="ts">
  import { onMount } from 'svelte';
  import { controlDialogChoices } from '../ui/keyboard/dialog-choices.ts';
  import './keyboard-dialog.css';

  let { completed, total, ready, start, cancel }: {
    completed: number; total: number; ready: boolean; start: () => void; cancel: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let cancelButton: HTMLButtonElement;
  let startButton = $state<HTMLButtonElement>();

  onMount(() => {
    const element = dialog;
    const previousFocus = document.activeElement;
    element.showModal();
    ((ready ? startButton : undefined) ?? cancelButton).focus();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  });
  $effect(() => { if (ready && dialog?.open) startButton?.focus(); });
</script>

<dialog class="keyboard-dialog playback-preparation" bind:this={dialog} aria-labelledby="playback-preparation-title"
  aria-describedby="playback-preparation-keys" onkeydown={event => controlDialogChoices(event, dialog, ready ? startButton : cancelButton)} oncancel={event => {
  event.preventDefault();
  cancel();
}}>
  <header><h2 id="playback-preparation-title">Score Preview</h2></header>
  <div class="content">
    <h3 aria-live="polite">{ready ? 'Ready to play' : 'Loading piano samples…'}</h3>
    <progress aria-label="Piano samples loaded" max={total} value={completed}></progress>
    <output>{completed} / {total}</output>
  </div>
  <footer>
    <div class="choices">
      <button type="button" bind:this={cancelButton} onclick={cancel}>Cancel</button>
      <button type="button" bind:this={startButton} disabled={!ready} onclick={start}>Start</button>
    </div>
    <p class="keyboard-hint" id="playback-preparation-keys">← / → Select · Enter Confirm · Esc Cancel</p>
  </footer>
</dialog>

<style>
  .playback-preparation { width: min(440px, calc(100vw - 48px)); }
  .content { padding: 18px 24px; }
  h2 { margin: 0; font-size: 20px; }
  h3 { margin: 0; font-size: 15px; }
  output { display: block; font-size: 13px; text-align: right; }
</style>
