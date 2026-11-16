import AutomaticFingering, { type FingeringResult } from '../../domain/performance/automatic-fingering.ts';
import FingeringPassage from '../../domain/performance/fingering-passage.ts';
import type { FingeringSelection } from '../../domain/score/fingering-selection.ts';
import type { ScoreProject } from '../../domain/score/types.ts';

self.onmessage = (event: MessageEvent<{ project: ScoreProject; selection: FingeringSelection }>) => {
  let result: FingeringResult;
  try {
    const prepared = FingeringPassage.prepare(event.data.project, event.data.selection);
    result = prepared.passage ? AutomaticFingering.calculate(prepared.passage, progress => self.postMessage({ type: 'progress', progress }))
      : { candidates: [], issues: prepared.issues };
  } catch (error) {
    result = { candidates: [], issues: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  self.postMessage({ type: 'result', result });
};
