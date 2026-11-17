import Calculation from '../fingering/fingering-calculation.ts';
import Selection, { type FingeringSelection } from '../../domain/score/fingering-selection.ts';
import FingeringEditor from '../../action/editor/fingering-editor.ts';
import { AuthoringError } from '../../domain/score/score-authoring-input.ts';
import type { ScoreProject } from '../../domain/score/types.ts';
import type { FingeringResult, FingeringProgress } from '../../domain/performance/automatic-fingering.ts';

type Checkout = { project: ScoreProject; revision: string };
type Job = { jobId: string; requestId: string; content: string; revision: string; selection: FingeringSelection;
  scope?: { includedNoteIds: string[]; addedNotes: number; voiceCount: number }; progress?: FingeringProgress; result?: FingeringResult; calculation?: { cancel(): void }; applied?: unknown };
namespace FingeringJobs {
  export function create(start = Calculation.start) {
    const jobs = new Map<string, Job>();
    const fail = (code: string, message: string): never => { throw new AuthoringError(code, 'autoFingering', message); };
    return {
      clear() { for (const job of jobs.values()) job.calculation?.cancel(); jobs.clear(); },
      handle(method: string, params: Record<string, unknown>, checkout: Checkout) {
        if (method === 'requestAutoFingering') {
          if (typeof params.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(params.requestId)) fail('INVALID_ARGUMENT', 'Provide a unique requestId.');
          if ((params.staff !== 'upperStaff' && params.staff !== 'lowerStaff') || !Array.isArray(params.noteIds) || !params.noteIds.length || params.noteIds.length > 256 || params.noteIds.some(id => typeof id !== 'string'))
            fail('INVALID_ARGUMENT', 'Provide staff and 1–256 existing noteIds in one continuous voice range, including entire ties.');
          const content = JSON.stringify([params.expectedRevision, params.staff, params.noteIds]);
          const prior = [...jobs.values()].find(job => job.requestId === params.requestId);
          if (prior) {
            if (prior.content !== content) fail('REQUEST_ID_CONFLICT', 'requestId was already used with different arguments.');
            return { jobId: prior.jobId, revision: prior.revision, ...prior.scope };
          }
          if (params.expectedRevision !== checkout.revision) fail('STALE_REVISION', 'Read the current checkout revision before calculating.');
          if ([...jobs.values()].some(job => job.calculation)) fail('CALCULATION_BUSY', 'Wait for the running calculation or cancel the checkout.');
          if (jobs.size >= 16) fail('REQUEST_LIMIT', 'At most 16 calculations per checkout.');
          const selection: FingeringSelection = { staff: params.staff as FingeringSelection['staff'], noteIds: params.noteIds as string[] };
          const inspection = Selection.inspect(checkout.project, selection);
          if (inspection.entries.length > 256) fail('REQUEST_LIMIT', 'The expanded hand passage exceeds 256 notes for MCP. Select a shorter range.');
          const job: Job = { jobId: crypto.randomUUID(), requestId: params.requestId as string, content, revision: checkout.revision, selection };
          job.scope = { includedNoteIds: inspection.entries.map(entry => entry.note.id), addedNotes: inspection.addedNotes, voiceCount: inspection.voiceCount };
          jobs.set(job.jobId, job);
          if (inspection.issues.length) job.result = { candidates: [], issues: inspection.issues };
          else {
            try { job.calculation = start(checkout.project, selection, progress => { job.progress = progress; }, result => { job.calculation = undefined; job.result = result; }); }
            catch (error) { job.result = { candidates: [], issues: [{ message: error instanceof Error ? error.message : String(error) }] }; }
          }
          return { jobId: job.jobId, revision: job.revision, ...job.scope };
        }
        const job = jobs.get(params.jobId as string);
        if (!job) fail('TARGET_NOT_FOUND', 'No such automatic fingering job in this checkout.');
        if (method === 'getAutoFingeringResult') return { jobId: job!.jobId, revision: job!.revision,
          status: job!.applied ? 'applied' : !job!.result ? 'running' : job!.result.candidates.length ? 'ready' : 'failed',
          ...job!.scope, progress: job!.progress, result: job!.result };
        if (job!.applied) return job!.applied;
        if (params.expectedRevision !== checkout.revision || job!.revision !== checkout.revision) fail('STALE_REVISION', 'The checkout changed since calculation. Request a new calculation.');
        if (!job!.result) fail('CALCULATION_BUSY', 'Calculation is still running.');
        const candidate = job!.result!.candidates[0];
        if (!candidate) fail('NO_CANDIDATE', 'Calculation failed. Read its issues before continuing.');
        const next = FingeringEditor.apply(checkout.project, job!.selection, candidate.assignments);
        const changed = next !== checkout.project;
        checkout.project = next;
        if (changed) checkout.revision = crypto.randomUUID();
        job!.applied = { jobId: job!.jobId, changed, revision: checkout.revision, assignedPitches: candidate.assignments.length };
        return job!.applied;
      },
    };
  }
}
export default FingeringJobs;
