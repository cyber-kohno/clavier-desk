<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import FingeringSelection, { type FingeringSelection as Selection, type FingeringAssignment } from '../domain/score/fingering-selection.ts';
  import type { ScoreProject } from '../domain/score/types.ts';
  import type { FingeringProgress, FingeringResult } from '../domain/performance/automatic-fingering.ts';
  import FingeringCalculation from '../service/fingering/fingering-calculation.ts';
  import { controlDialogChoices } from '../ui/keyboard/dialog-choices.ts';
  import './keyboard-dialog.css';

  let { project, selection, apply, close }: { project: ScoreProject; selection: Selection;
    apply: (assignments: readonly FingeringAssignment[]) => void; close: () => void } = $props();
  const inspection = $derived(FingeringSelection.inspect(project, selection));
  let phase = $state<'confirm' | 'running' | 'result'>('confirm');
  let progress = $state<FingeringProgress>({ phase: 'search', completed: 0, total: 1 });
  let result = $state.raw<FingeringResult | null>(null);
  const draft = $derived(result?.candidates[0]);
  const assignmentKey = (item: { noteId: string; graceNoteId?: string; trillAttackIndex?: number }, pitchIndex: number) =>
    JSON.stringify([item.noteId, item.graceNoteId, item.trillAttackIndex, pitchIndex]);
  const assigned = $derived(new Map(draft?.assignments.map(item => [assignmentKey(item, item.pitchIndex), item.finger]) ?? []));
  let calculation: ReturnType<typeof FingeringCalculation.start> | undefined;
  let dialog: HTMLDialogElement;
  let scrollArea = $state<HTMLDivElement>();
  let primary = $state<HTMLButtonElement>();
  let returnFocus: HTMLElement | null = null;
  onMount(() => {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal(); void focusPrimary();
  });
  onDestroy(() => {
    calculation?.cancel();
    if (returnFocus?.isConnected) returnFocus.focus();
  });
  async function focusPrimary() {
    await tick();
    if (scrollArea) scrollArea.scrollTop = 0;
    if (primary && !primary.disabled) primary.focus();
    else dialog.querySelector<HTMLButtonElement>('footer button:not(:disabled)')?.focus();
  }
  function controlKey(event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (scrollArea) scrollArea.scrollTop += event.key === 'ArrowUp' ? -48 : 48;
      return;
    }
    controlDialogChoices(event, dialog, primary);
  }
  function calculate() {
    if (phase === 'running' || inspection.issues.length || !inspection.missing) return;
    phase = 'running'; result = null; progress = { phase: 'search', completed: 0, total: inspection.performanceAttacks.length };
    try {
      calculation = FingeringCalculation.start(project, selection, value => progress = value, value => {
        calculation = undefined; result = value; phase = 'result'; void focusPrimary();
      });
    } catch (error) {
      result = { candidates: [], issues: [{ message: error instanceof Error ? error.message : String(error) }] };
      phase = 'result'; void focusPrimary();
    }
    void focusPrimary();
  }
  function cancelCalculation() {
    calculation?.cancel(); calculation = undefined; phase = 'confirm'; void focusPrimary();
  }
  function pitchName(midi: number) { return `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][midi % 12]}${Math.floor(midi / 12) - 1}`; }
</script>

<dialog class="fingering-modal keyboard-dialog" bind:this={dialog} tabindex="-1" aria-labelledby="fingering-title"
  onkeydown={controlKey}
  oncancel={event => { event.preventDefault(); if (phase === 'running') cancelCalculation(); else close(); }}>
  <header>
    <h2 id="fingering-title">Auto Fingering</h2>
    <p>{selection.staff === 'upperStaff' ? 'Right hand · Upper staff' : 'Left hand · Lower staff'} · {inspection.voiceCount} voice(s) · Measures {inspection.firstMeasure}–{inspection.lastMeasure}</p>
  </header>
  <div class="content">
    <div class="counts" aria-label="Selection summary">
      <span><strong>{inspection.performanceAttacks.length}</strong> attacks / chords</span>
      <span><strong>{inspection.fixed}</strong> fixed pitches</span>
      <span><strong>{inspection.missing}</strong> unassigned pitches</span>
    </div>
    <div class="summary">
    {#if phase === 'confirm'}
      <h3>Review selection</h3>
      <p>Assigned fingers stay fixed. Only unassigned pitches will be filled.</p>
      <p>{inspection.addedNotes} additional notes included from overlapping voices and complete ties. All listed unassigned pitches will be filled and checked together.</p>
      <p class="hint">To guide the result, assign fingers to important notes before opening this dialog.</p>
    {:else if phase === 'running'}
      <h3 aria-live="polite">{progress.phase === 'search' ? 'Calculating fingering…' : 'Checking hand animation…'}</h3>
      <progress max={Math.max(1, progress.total)} value={progress.completed} aria-label={progress.phase === 'search' ? 'Fingering search progress' : 'Animation validation progress'}></progress>
      <p>No changes have been applied. You can cancel this calculation.</p>
    {:else if draft}
      <h3 role="status">Ready to apply · {draft.assignments.length} pitches filled</h3>
      <p>The selected passage passed validation with the current hand animation model.</p>
      <p>{draft.warnings.length} locations flagged for review under the engine's movement and stretch rules.</p>
      <p class="hint">Fixed fingers are marked “fixed”. New fingerings appear below. The score changes only when you apply.</p>
    {:else}
      <h3 role="alert">Could not complete the fingering</h3>
      <p>No changes have been applied.</p>
    {/if}
    </div>
    <div class="scroll-area" bind:this={scrollArea} role="region" aria-label={draft ? 'Fingering result' : 'Fingering details'}>
    {#if phase === 'confirm'}
      {#if inspection.issues.length}
        <div class="issues" role="alert"><h3>Selection needs attention</h3><ul>{#each inspection.issues as issue}<li>{issue.message}</li>{/each}</ul></div>
      {:else if !inspection.missing}
        {#if !inspection.total && inspection.glissandoNotes}
          <p role="status">Glissando notes use a fixed hand shape and do not need fingering.</p>
        {:else}
          <p role="status">All assignable pitches already have fingers. Use Fingering → Clear to start again.</p>
        {/if}
      {/if}
    {:else if phase === 'result' && draft}
      {#if draft.warnings.length}<ul class="warnings">{#each draft.warnings as warning}<li>{warning.message}</li>{/each}</ul>{/if}
      <div class="result-table">
        <table><thead><tr><th>Note / chord</th><th>Pitch</th><th>Finger</th><th>Status</th></tr></thead>
          <tbody>{#each inspection.performanceAttacks as entry, index}{#each entry.note.pitches as pitch, pitchIndex}
            <tr><td>{index + 1}{entry.trillAttackIndex !== undefined ? ` (trill ${entry.trillAttackIndex + 1})` : entry.graceNoteId ? " (grace)" : ""}</td><td>{pitchName(pitch.midi)}</td><td>{pitch.fingering ?? assigned.get(assignmentKey(entry, pitchIndex))}</td><td>{pitch.fingering === undefined ? 'New' : 'Fixed'}</td></tr>
          {/each}{/each}</tbody>
        </table>
      </div>
    {:else if phase === 'result'}
      <ul class="issues">{#each result?.issues ?? [] as issue}<li>{issue.message}</li>{/each}</ul>
    {/if}
    </div>
  </div>
  <footer>
    <div class="choices">
    {#if phase === 'running'}
      <button type="button" bind:this={primary} onclick={cancelCalculation}>Cancel calculation</button>
    {:else if phase === 'result'}
      <button type="button" onclick={close}>Close</button>
      <button type="button" onclick={() => { result = null; phase = 'confirm'; void focusPrimary(); }}>Back</button>
      {#if draft}<button type="button" bind:this={primary} onclick={() => apply(draft.assignments)}>Apply</button>{/if}
    {:else}
      <button type="button" onclick={close}>Cancel</button>
      <button type="button" bind:this={primary} disabled={inspection.issues.length > 0 || !inspection.missing} onclick={calculate}>Calculate</button>
    {/if}
    </div>
    <p class="keyboard-hint">← / → Select · Enter Confirm · ↑ / ↓ Scroll · Esc {phase === 'running' ? 'Stop' : 'Close'}</p>
  </footer>
</dialog>

<style>
  .fingering-modal { width: min(720px, calc(100vw - 48px)); height: 640px; max-height: calc(100vh - 48px); overflow: hidden; }
  .fingering-modal[open] { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
  h2 { margin: 0 0 8px; font-size: 20px; } h3 { font-size: 15px; margin: 16px 0 8px; }
  p { line-height: 1.55; margin: 8px 0; font-size: 13px; } header p { margin: 0; }
  .content { min-height: 0; display: flex; flex-direction: column; padding: 18px 24px; overflow: hidden; }
  .summary { flex-shrink: 0; }
  .scroll-area { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain; }
  .scroll-area::-webkit-scrollbar { display: none; }
  .counts { flex-shrink: 0; display: flex; flex-wrap: wrap; gap: 12px 24px; padding-bottom: 12px; border-bottom: 1px solid #cedada; font-size: 13px; }
  .counts strong { font-size: 19px; margin-right: 4px; }
  .hint { color: #526b6b; } .issues { color: #8b3434; } .warnings { color: #755019; }
  ul { padding-left: 20px; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
  li { margin: 8px 0; }
  .result-table { border: 1px solid #c3d2d2; border-radius: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
  th { position: sticky; top: 0; z-index: 1; background: #e7efef; } th, td { padding: 7px 12px; border-bottom: 1px solid #dce5e5; }
</style>
