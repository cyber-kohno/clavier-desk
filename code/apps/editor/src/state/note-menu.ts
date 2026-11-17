
import ScoreSlur from "../domain/score/score-slur.ts";
import FingeringSelection from '../domain/score/fingering-selection.ts';
import ScoreTimeline from '../domain/score/score-timeline.ts';

import type { ScoreProject } from "../domain/score/types.ts";
export type MenuItem = { label: string; children?: MenuItem[]; action?: 'expression' | 'add-slur' | 'remove-slur' | 'auto-fingering' | 'clear-fingering' | 'exit'; disabled?: boolean; reason?: string };
export const noteMenuItems: MenuItem[] = [
  { label: 'Expression…', action: 'expression' },
  { label: 'Add slur to selection', action: 'add-slur' },
  { label: 'Remove slur', action: 'remove-slur' },
  { label: 'Fingering', children: [
    { label: 'Auto Assign…', action: 'auto-fingering' },
    { label: 'Clear', action: 'clear-fingering' },
  ] },
  { label: 'Exit', action: 'exit' },
];
export function createNoteMenuItems(project: ScoreProject, ids: readonly string[], checkClear = true): MenuItem[] {
  const slur = ScoreSlur.availability(project, ids);
  const clear = checkClear ? clearAvailability(project, ids) : undefined;
  return noteMenuItems.map(item => item.children ? { ...item, children: item.children.map(child => child.action === 'clear-fingering'
    ? { ...child, disabled: !clear?.allowed, reason: clear?.reason } : { ...child, disabled: !ids.length, reason: 'Select notes.' }) }
    : item.action === 'expression' ? { ...item, disabled: ids.length !== 1, reason: 'Select one note.' }
    : item.action === 'add-slur' ? { ...item, disabled: !slur.canAdd, reason: slur.addReason }
    : item.action === 'remove-slur' ? { ...item, disabled: !slur.canRemove, reason: slur.removeReason } : item);
}
function clearAvailability(project: ScoreProject, ids: readonly string[]) {
  const staff = ids[0] && ScoreTimeline.note(project.outline, ids[0], 'lowerStaff') ? 'lowerStaff' : 'upperStaff';
  return FingeringSelection.clearAvailability(project, { staff, noteIds: ids });
}
export function menuItemsAt(path: number[], rootItems = noteMenuItems) {
  let items = rootItems;
  for (const index of path.slice(0, -1)) items = items[index]?.children ?? [];
  return items;
}
export function controlNoteMenu(path: number[], key: string, rootItems = noteMenuItems): { path: number[] | null; action?: MenuItem['action'] } {
  const items = menuItemsAt(path, rootItems), index = path.at(-1)!, item = items[index];
  if (key === 'Escape' || key.toLowerCase() === 'm') return { path: null };
  if (key === 'ArrowUp' || key === 'ArrowDown') return { path: [...path.slice(0, -1), Math.max(0, Math.min(items.length - 1, index + (key === 'ArrowUp' ? -1 : 1)))] };
  if (key === 'ArrowLeft') return { path: path.length > 1 ? path.slice(0, -1) : path };
  if (key === 'ArrowRight' || key === 'Enter') {
    if (item?.disabled) return { path };
    if (item?.children?.length) return { path: [...path, 0] };
    if (key === 'Enter' && item?.action) return { path: null, action: item.action };
  }
  return { path };
}
