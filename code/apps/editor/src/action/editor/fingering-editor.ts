import FingeringSelection, { type FingeringSelection as Selection, type FingeringAssignment } from '../../domain/score/fingering-selection.ts';
import type { ScoreProject } from '../../domain/score/types.ts';
import EditTransaction from './edit-transaction.ts';

namespace FingeringEditor {
  export function clear(project: ScoreProject, selection: Selection) {
    return EditTransaction.commitPitches(project, FingeringSelection.clear(project, selection));
  }
  export function apply(project: ScoreProject, selection: Selection, assignments: readonly FingeringAssignment[]) {
    return EditTransaction.commitPitches(project, FingeringSelection.apply(project, selection, assignments));
  }
}
export default FingeringEditor;
