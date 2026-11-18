import { restorePreparedMotion, type Note } from '../../domain/motion/motion.ts';
import type { AnimationGenerationMessage, AnimationMotionInput, AnimationProgress } from './animation-generation.ts';

type AnimationJob = {
  progress: (value: AnimationProgress) => void,
  complete: (notes: Note[]) => void,
  failed: (message: string) => void,
};

export function createAnimationCalculation() {
  let worker: Worker | undefined;
  let pending: AnimationJob | undefined;
  const cancel = () => {
    pending = undefined;
    worker?.terminate();
    worker = undefined;
  };
  function openWorker() {
    const instance = new Worker(new URL('../../infra/motion/animation-worker.ts', import.meta.url), { type: 'module' });
    const fail = (message: string) => {
      if (worker !== instance) return;
      const job = pending;
      cancel();
      job?.failed(message);
    };
    instance.onmessage = (event: MessageEvent<AnimationGenerationMessage>) => {
      if (worker !== instance || !pending) return;
      const reply = event.data, job = pending;
      if (reply.type === 'progress') {
        job.progress(reply.progress);
        return;
      }
      pending = undefined;
      if (reply.type === 'error') job.failed(reply.message);
      else {
        restorePreparedMotion(reply.motion);
        job.complete(reply.motion.notes);
      }
    };
    instance.onerror = event => {
      event.preventDefault();
      fail(event.message || 'Animation calculation could not start.');
    };
    instance.onmessageerror = () => fail('The animation calculation result could not be read.');
    return instance;
  }
  function start(input: AnimationMotionInput, job: AnimationJob) {
    if (pending) throw new Error('An animation calculation is already running.');
    worker ??= openWorker();
    pending = job;
    try { worker.postMessage(input); }
    catch (error) { cancel(); throw error; }
  }
  // Keep the worker's geometry caches available for Regenerate.
  return { start, cancel };
}
