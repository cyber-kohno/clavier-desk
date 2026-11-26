export function controlDialogChoices(event: KeyboardEvent, dialog: HTMLDialogElement, primary?: HTMLButtonElement) {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (!['ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) return;

  event.preventDefault();
  const choices = Array.from(dialog.querySelectorAll<HTMLButtonElement>('footer button:not(:disabled)'));
  if (!choices.length) return;
  const focused = choices.findIndex(button => button === document.activeElement);
  const current = focused >= 0 ? focused : Math.max(0, choices.findIndex(button => button === primary));
  if (event.key === 'Enter') {
    if (!event.repeat) choices[current].click();
  } else {
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    choices[Math.max(0, Math.min(choices.length - 1, current + direction))].focus();
  }
}
