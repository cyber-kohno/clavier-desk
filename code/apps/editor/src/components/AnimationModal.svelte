<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { ScoreProject } from '../domain/score/types.ts';
  import { inspectAnimation, animationAudio, type AnimationPerformance } from '../domain/performance/animation-performance.ts';
  import { generateAnimation } from '../service/playback/animation-generation.ts';
  import { createAnimationTransport } from '../service/playback/animation-transport.ts';
  import type { PlaybackInstrumentPort } from '../service/playback/playback-instrument.ts';
  import EditorDialogController from '../service/dialog/editor-dialog-controller.ts';
  import { editorDialogStore } from '../state/editor-dialog.ts';
  import type { createScene } from '../infra/motion/scene.ts';
  import { createAnimationCameraKeyboard } from '../state/animation-camera-keyboard.ts';

  export type AnimationSnapshot = { project: ScoreProject; performance: AnimationPerformance };
  let { project, snapshot = null, instrument, close, generated: saveSnapshot }: {
    project: ScoreProject; snapshot: AnimationSnapshot | null; instrument: PlaybackInstrumentPort | null;
    close: () => void; generated: (value: AnimationSnapshot | null) => void;
  } = $props();
  let panel: HTMLElement;
  let viewport: HTMLDivElement;
  let scene: ReturnType<typeof createScene> | undefined;
  let result = $state.raw<AnimationSnapshot | null>(untrack(() => snapshot));
  let position = $state(0);
  let playing = $state(false);
  let speed = $state(1);
  let loading = $state(false);
  let sceneReady = $state(false);
  let sceneError = $state('');
  let showNotes = $state(true);
  let alive = false;
  const cameraKeys = createAnimationCameraKeyboard();
  let hadDialog = false;
  $effect(() => {
    const open = $editorDialogStore !== null;
    if (open) cameraKeys.reset();
    if (!open && hadDialog) requestAnimationFrame(() => { if (alive) panel?.focus(); });
    hadDialog = open;
  });
  const inspection = $derived(inspectAnimation(project));
  const stale = $derived(result !== null && result.project !== project);
  const duration = $derived(result?.performance.duration ?? 0);
  const transport = createAnimationTransport(untrack(() => instrument), error => {
    playing = false;
    showError('Audio Playback Failed', error instanceof Error ? error.message : String(error));
  });

  function showError(title: string, message: string) {
    EditorDialogController.alert({ title, messageLines: [message] });
  }
  async function generate() {
    if (loading || !sceneReady) return;
    transport.pause(); playing = false;
    if (inspection.issues.length) {
      const lines = inspection.issues.slice(0, 6).map(issue => issue.message);
      if (inspection.issues.length > 6) lines.push(`${inspection.issues.length - 6} more issues. Correct the score and try again.`);
      EditorDialogController.alert({ title: 'Animation Unavailable', messageLines: lines });
      return;
    }
    loading = true; result = null; saveSnapshot(null); position = 0;
    await tick();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (!alive) return;
    try {
      const performance = generateAnimation(inspection.performance);
      result = { project, performance }; saveSnapshot(result);
      transport.setSequence(animationAudio(performance));
    } catch (error) { showError('Animation Generation Failed', error instanceof Error ? error.message : String(error)); }
    finally { loading = false; panel?.focus(); }
  }
  function toggle() {
    if (!result || loading) return;
    if (transport.playing) transport.pause(); else transport.play();
    position = transport.position; playing = transport.playing;
  }
  function seek(value: number) { transport.seek(value); position = transport.position; playing = false; }
  function changeSpeed(value: number) { speed = value; transport.setSpeed(speed); }
  function control(event: KeyboardEvent) {
    if (EditorDialogController.isOpen() || event.isComposing) return;
    // Do not let the opening Enter/G event reach the editor's dialog handler.
    event.stopPropagation();
    if (event.key === 'Tab') {
      cameraKeys.reset();
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) { cameraKeys.reset(); event.preventDefault(); return; }
    const editable = event.target instanceof HTMLElement && !!event.target.closest('input, select, button');
    const nativeInput = event.target instanceof HTMLElement && !!event.target.closest('input, select, textarea, [contenteditable="true"]');
    if (!nativeInput && cameraKeys.press(event)) {
      event.preventDefault();
      if (!event.repeat) scene?.moveCamera(cameraKeys.input(), 1 / 60);
      return;
    }
    if (event.key === 'Enter' && !editable) { event.preventDefault(); if (!event.repeat) { if (result) toggle(); else void generate(); } }
    else if (event.key === ' ' && !editable) { event.preventDefault(); if (!event.repeat) toggle(); }
    else if (event.key.toLowerCase() === 'g') { event.preventDefault(); if (!event.repeat) void generate(); }
    else if (event.key.toLowerCase() === 'n') { event.preventDefault(); if (!event.repeat) showNotes = !showNotes; }
    else if (event.key.toLowerCase() === 'v') { event.preventDefault(); cameraKeys.reset(); scene?.view('notes'); }
    else if (!editable && ['Home', 'End'].includes(event.key)) {
      event.preventDefault();
      seek(event.key === 'Home' ? 0 : duration);
    } else if (!editable && (event.key === '[' || event.key === ']')) {
      event.preventDefault(); const values = [0.25, 0.5, 1, 1.5, 2];
      changeSpeed(values[Math.max(0, Math.min(values.length - 1, values.indexOf(speed) + (event.key === '[' ? -1 : 1)))]);
    } else if (event.key.toLowerCase() === 'r' || event.key.toLowerCase() === 't') {
      event.preventDefault(); cameraKeys.reset(); scene?.view(event.key.toLowerCase() === 't');
    }
  }
  onMount(() => {
    alive = true; panel.focus();
    const release = (event: KeyboardEvent) => cameraKeys.release(event);
    const resetCameraKeys = () => cameraKeys.reset();
    const visibility = () => { if (document.hidden) cameraKeys.reset(); };
    window.addEventListener('keyup', release);
    window.addEventListener('blur', resetCameraKeys);
    document.addEventListener('visibilitychange', visibility);
    panel.addEventListener('focusin', resetCameraKeys);
    panel.addEventListener('pointerdown', resetCameraKeys);
    if (result) transport.setSequence(animationAudio(result.performance));
    let frame = 0;
    void import('../infra/motion/scene.ts').then(module => {
      if (!alive) return;
      try {
        scene = module.createScene(viewport); sceneReady = true;
        let previousFrame = performance.now();
        const render = (now: number) => {
          if (!alive) return;
          scene?.moveCamera(cameraKeys.input(), (now - previousFrame) / 1000);
          previousFrame = now;
          position = transport.position; playing = transport.playing;
          try { scene?.draw(result?.performance.notes ?? [], position, false, undefined, 'scale', true, 'connected', 'smooth', true, result?.performance, showNotes); }
          catch (error) {
            transport.pause(); playing = false; result = null; saveSnapshot(null);
            showError('Animation Playback Failed', error instanceof Error ? error.message : String(error));
          }
          frame = requestAnimationFrame(render);
        };
        render(performance.now());
      } catch (error) { sceneError = '3D rendering is unavailable.'; showError('3D Rendering Failed', `${sceneError} ${error instanceof Error ? error.message : String(error)}`); }
    }).catch(() => { if (alive) { sceneError = 'The 3D renderer could not be loaded.'; showError('3D Rendering Failed', sceneError); } });
    return () => {
      alive = false; cancelAnimationFrame(frame); transport.dispose(); scene?.dispose(); cameraKeys.reset();
      window.removeEventListener('keyup', release);
      window.removeEventListener('blur', resetCameraKeys);
      document.removeEventListener('visibilitychange', visibility);
      panel.removeEventListener('focusin', resetCameraKeys);
      panel.removeEventListener('pointerdown', resetCameraKeys);
    };
  });
</script>

<div class="overlay">
  <div class="animation-modal" role="dialog" aria-modal="true" aria-labelledby="animation-title" aria-describedby="animation-help"
    tabindex="-1" bind:this={panel} onkeydown={control} inert={$editorDialogStore !== null}>
    <header><h2 id="animation-title">Hand Animation</h2><button onclick={close}>Close <kbd>Esc</kbd></button></header>
    <div class="status" aria-live="polite">
      <span>{sceneError || (loading ? 'Generating animation…' : result ? (stale ? 'Score updated — regenerate to apply changes.' : 'Animation ready') :
        `Fingering ${inspection.assigned}/${inspection.attacks} · ${inspection.issues.length ? 'Score needs attention' : 'Ready to generate'}`)}{!instrument ? ' · Audio unavailable' : ''}</span>
      <button disabled={loading || !sceneReady} onclick={generate}>{result ? 'Regenerate' : 'Generate'} <kbd>G</kbd></button>
    </div>
    <div class="stage">
      <div class="viewport" bind:this={viewport}></div>
      {#if !result}<div class="placeholder">{loading ? 'Preparing hand motion…' : sceneError || 'Generate an animation from the current score.'}</div>{/if}
      <nav aria-label="Camera views">
        <button aria-pressed={showNotes} onclick={() => showNotes = !showNotes}>Notes {showNotes ? 'on' : 'off'} <kbd>N</kbd></button>
        <button onclick={() => scene?.view('notes')}>Note view <kbd>V</kbd></button>
        <button onclick={() => scene?.view(false)}>Reset view <kbd>R</kbd></button><button onclick={() => scene?.view(true)}>Top view <kbd>T</kbd></button>
      </nav>
    </div>
    <footer>
      <div class="transport">
        <button disabled={!result || loading} onclick={toggle}>{playing ? 'Pause' : 'Play'}</button>
        <input aria-label="Playback position" type="range" min="0" max={duration} step={0.01} value={position}
          onkeydown={event => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
              event.preventDefault(); event.stopPropagation();
              seek(position + (['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1) * (event.shiftKey ? 1 / 60 : 1));
            }
          }}
          disabled={!result || loading} oninput={event => seek(Number(event.currentTarget.value))} />
        <output>{position.toFixed(2)} / {duration.toFixed(2)} s</output>
        <select aria-label="Playback speed" value={speed} onchange={event => changeSpeed(Number(event.currentTarget.value))}>
          <option value={0.25}>0.25×</option><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={1.5}>1.5×</option><option value={2}>2×</option>
        </select>
      </div>
      <p id="animation-help">Arrows: pan · Shift+arrows: rotate · +/−: zoom · N: notes · V: note view · R/T: reset/top · Space: play · Tab to seek bar: arrows seek</p>
    </footer>
  </div>
</div>

<style>
  .overlay { position: fixed; z-index: 9500; inset: 0; display: grid; place-items: center; background: rgb(8 20 27 / 65%); }
  .animation-modal { box-sizing: border-box; width: 1040px; height: 720px; display: grid; grid-template-rows: 48px 40px minmax(0, 1fr) 80px; border: 1px solid #6d9caa; border-radius: 5px; overflow: hidden; background: #dce9eb; color: #20363d; box-shadow: 0 12px 38px #0006; outline: none; }
  header, .status { display: flex; align-items: center; justify-content: space-between; padding: 0 14px; gap: 12px; }
  header { background: #c5dcd9; border-bottom: 1px solid #9eb7b8; }
  h2 { font-size: 15px; margin: 0; }
  .status { font-size: 12px; }
  button, select { color: #20363d; background: #edf4f4; border: 1px solid #698892; border-radius: 3px; padding: 5px 10px; font: inherit; font-size: 12px; }
  button { cursor: pointer; white-space: nowrap; }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #087f90; outline-offset: 2px; }
  kbd { font: inherit; opacity: 0.65; margin-left: 5px; }
  .stage { position: relative; min-height: 0; background: #101a25; }
  .viewport { position: absolute; inset: 0; }
  .viewport :global(canvas) { display: block; }
  .placeholder { position: absolute; inset: 0; display: grid; place-items: center; background: #101a25b8; color: #dce9eb; font-size: 14px; pointer-events: none; }
  nav { position: absolute; right: 12px; top: 12px; display: flex; gap: 8px; }
  footer { padding: 10px 14px 8px; box-sizing: border-box; }
  .transport { display: flex; gap: 12px; align-items: center; }
  .transport button { width: 70px; }
  input { flex: 1; min-width: 0; accent-color: #326f79; }
  output { width: 150px; font: 12px monospace; text-align: right; white-space: nowrap; }
  footer p { margin: 8px 0 0; font-size: 11px; color: #536970; }
</style>
