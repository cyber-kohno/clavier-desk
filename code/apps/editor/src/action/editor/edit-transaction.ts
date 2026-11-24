
import ScoreSlur from "../../domain/score/score-slur.ts";

import ScoreClef from "../../domain/score/score-clef.ts";

import ScoreTempo from "../../domain/score/score-tempo.ts";

import ScoreTrill from "../../domain/score/score-trill.ts";
import ScoreFermata from '../../domain/score/score-fermata.ts';
import ScoreDynamics from '../../domain/score/score-dynamics.ts';
import ScoreHairpins from '../../domain/score/score-hairpins.ts';
import ScoreGlissando from '../../domain/score/score-glissando.ts';
import ScoreTimeline from '../../domain/score/score-timeline.ts';
import TieFingerings from '../../domain/score/tie-fingerings.ts';
import type { ScoreProject } from "../../domain/score/types.ts";

export type NormalizedRange = { oldNoteId: string; newNoteId: string };
/** Single commit boundary shared by every project-changing editor action. */
namespace EditTransaction {
  /** Pitch-only actions preserve note IDs, written durations and expression anchors.
   * They still validate collisions in NotePitches and reconcile affected trills. */
  export function commitPitches(before: ScoreProject, after: ScoreProject): ScoreProject {
    return before === after ? before : ScoreGlissando.clearFingerings(
      TieFingerings.reconcile(before, ScoreGlissando.reconcile(ScoreTrill.reconcile(before, after))));
  }
  export function commit(before: ScoreProject, after: ScoreProject, normalized?: NormalizedRange): ScoreProject {
    if (before === after) return before;
    const next = ScoreFermata.reconcileCaptured(ScoreFermata.capture(before), after);
    if (ScoreFermata.hasConflicts(next)) return before;
    return reconcileExpressions(before, ScoreHairpins.reconcile(next), normalized);
  }
  /** Local time edits preserve the measure layout. Fermatas never span barlines,
   * so only source/destination measures can gain a conflict or lose an attachment. */
  export function commitTime(before: ScoreProject, after: ScoreProject): ScoreProject {
    if (before === after) return before;
    if (before.outline.length !== after.outline.length) return commit(before, after);
    const measures = new Set<string>();
    for (let i = 0; i < before.outline.length; i++) {
      const old = before.outline[i], next = after.outline[i];
      if (old === next) continue;
      if (old.type !== 'measure' || next.type !== 'measure' || old.id !== next.id ||
        old.data.length.cnt !== next.data.length.cnt || old.data.length.unit !== next.data.length.unit) return commit(before, after);
      measures.add(old.id);
    }
    const next = ScoreFermata.reconcileCaptured(ScoreFermata.capture(before, measures), after, new Set(), measures);
    if (ScoreFermata.hasConflicts(next, measures)) return before;
    if (ScoreTimeline.isPrepared(before.outline)) ScoreTimeline.prepare(next.outline);
    return reconcileExpressions(before, next);
  }
  function reconcileExpressions(before: ScoreProject, next: ScoreProject, normalized?: NormalizedRange): ScoreProject {
    const reconciled = ScoreDynamics.reconcile(ScoreSlur.reconcile(ScoreClef.reconcile(ScoreTempo.reconcile(ScoreTrill.reconcile(before, next, normalized)))));
    const withHairpins = ScoreDynamics.reconcileHairpins(before, ScoreGlissando.reconcile(reconciled));
    return withHairpins ? ScoreGlissando.clearFingerings(TieFingerings.reconcile(before, withHairpins)) : before;
  }
}
export default EditTransaction;
