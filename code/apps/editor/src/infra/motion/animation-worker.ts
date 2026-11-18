import { generateAnimationMotion, type AnimationGenerationMessage, type AnimationMotionInput } from '../../service/playback/animation-generation.ts';

function send(message: AnimationGenerationMessage) {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<AnimationMotionInput>) => {
  let phase: string | undefined;
  let lastUpdate = -Infinity;
  try {
    const motion = generateAnimationMotion(event.data, progress => {
      const now = performance.now();
      if (phase === progress.phase && now - lastUpdate < 100) return;
      phase = progress.phase;
      lastUpdate = now;
      send({ type: 'progress', progress });
    });
    send({ type: 'result', motion });
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
