import type { FingeringProgress, FingeringResult } from '../../domain/performance/automatic-fingering.ts';
import type { FingeringSelection } from '../../domain/score/fingering-selection.ts';
import type { ScoreProject } from '../../domain/score/types.ts';

export type FingeringCalculation = { cancel(): void };
namespace FingeringCalculation {
  export function start(project: ScoreProject, selection: FingeringSelection,
    progress: (value: FingeringProgress) => void, complete: (value: FingeringResult) => void): FingeringCalculation {
    const worker = new Worker(new URL('../../infra/fingering/fingering-worker.ts', import.meta.url), { type: 'module' });
    let active = true;
    const cancel = () => { active = false; worker.terminate(); };
    worker.onmessage = (event: MessageEvent<{ type: 'progress'; progress: FingeringProgress } | { type: 'result'; result: FingeringResult }>) => {
      if (!active) return;
      if (event.data.type === 'progress') progress(event.data.progress);
      else { cancel(); complete(event.data.result); }
    };
    worker.onerror = event => {
      event.preventDefault();
      if (!active) return;
      cancel(); complete({ candidates: [], issues: [{ message: event.message || 'Fingering calculation could not start.' }] });
    };
    try { worker.postMessage({ project, selection }); }
    catch (error) { cancel(); throw error; }
    return { cancel };
  }
}
export default FingeringCalculation;
