import { Sequencer, WorkletSynthesizer } from 'spessasynth_lib';
import processorUrl from 'spessasynth_lib/dist/spessasynth_processor.min.js?url';
import pianoLimiterUrl from './piano-peak-limiter.js?url&no-inline';
import type { PlaybackInstrumentPort, PlaybackSequence } from '../../service/playback/playback-instrument.ts';
import { createPlaybackMidi } from './playback-midi.ts';
import { createPianoSamplePreparation } from './piano-sample-preparation.ts';
import { createWorkletSequencePlayer } from './worklet-sequence-player.ts';

const LOCAL_PIANO_URL = '/assets/soundfonts/ivy-audio-piano-in-162-close.sf3';
// Paired with the per-layer attenuation in the local SF3.
const LOCAL_PIANO_GAIN_DB = 20.5;
const BUNDLED_PIANO_URL = '/assets/soundfonts/clavierdesk-grand-piano.sf2';
const SOUND_FONT_ID = 'clavierdesk-grand-piano';

namespace SpessaSynthInstrument {
  function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  export async function loadPiano(): Promise<PlaybackInstrumentPort> {
    const localResponse = await fetch(new URL(LOCAL_PIANO_URL, window.location.href));
    // Vite can return the app's HTML when a local asset is absent.
    const useBundledPiano = localResponse.status === 404
      || localResponse.headers.get('content-type')?.startsWith('text/html') === true;
    const response = useBundledPiano
      ? await fetch(new URL(BUNDLED_PIANO_URL, window.location.href))
      : localResponse;
    if (!response.ok) throw new Error(`SoundFont request failed (${response.status}).`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 12 || new TextDecoder().decode(bytes.subarray(8, 12)) !== 'sfbk') {
      throw new Error('The piano SoundFont is not a valid SF2 or SF3 file.');
    }

    const context = new AudioContext();
    try {
      await context.audioWorklet.addModule(processorUrl);
      if (!useBundledPiano) await context.audioWorklet.addModule(pianoLimiterUrl);
      const synth = new WorkletSynthesizer(context);
      if (useBundledPiano) {
        synth.connect(context.destination);
      } else {
        const outputGain = context.createGain();
        outputGain.gain.value = 10 ** (LOCAL_PIANO_GAIN_DB / 20);
        const limiter = new AudioWorkletNode(context, 'clavierdesk-piano-peak-limiter', {
          outputChannelCount: [2],
        });
        synth.connect(outputGain);
        outputGain.connect(limiter);
        limiter.connect(context.destination);
      }
      await synth.soundBankManager.addSoundBank(toArrayBuffer(bytes), SOUND_FONT_ID);
      await synth.isReady;
      synth.programChange(0, 0);

      const sequencer = new Sequencer(synth, { skipToFirstNoteOn: false });
      sequencer.loopCount = 0;
      sequencer.eventHandler.timeDelay = 0;
      // A second, paused sequencer warms the same synth's sample cache in small batches.
      const preloader = useBundledPiano ? undefined : new Sequencer(synth, { skipToFirstNoteOn: false });
      let batch: { resolve(): void; reject(error: unknown): void } | undefined;
      const preparation = preloader && createPianoSamplePreparation(() => context.resume(), sequence =>
        new Promise<void>((resolve, reject) => {
          const binary = createPlaybackMidi(sequence);
          batch = { resolve, reject };
          try { preloader.loadNewSongList([{ binary }]); }
          catch (error) { batch = undefined; reject(error); }
        }));
      if (preloader) {
        preloader.eventHandler.timeDelay = 0;
        preloader.eventHandler.addEvent('songChange', 'sample-preparation', () => {
          const completed = batch;
          batch = undefined;
          completed?.resolve();
        });
        preloader.eventHandler.addEvent('midiError', 'sample-preparation', error => {
          const failed = batch;
          batch = undefined;
          failed?.reject(error);
        });
      }
      const player = createWorkletSequencePlayer({
        resume: () => context.resume(),
        load: binary => sequencer.loadNewSongList([{ binary }]),
        play: () => { sequencer.currentTime = 0; sequencer.play(); },
        pause: () => sequencer.pause(),
        get currentTime() { return sequencer.currentTime; },
        silence() {
          for (let channel = 0; channel < 16; channel++) synth.controllerChange(channel, 64, 0);
          synth.stopAll(true);
        },
      });
      sequencer.eventHandler.addEvent('songChange', 'clavierdesk', () => player.loaded());
      sequencer.eventHandler.addEvent('songEnded', 'clavierdesk', () => player.ended());
      sequencer.eventHandler.addEvent('midiError', 'clavierdesk', error => player.failed(error));
      return {
        prepareSequence: preparation?.prepareSequence,
        startSequence: (sequence, callbacks, options) => player.startSequence(sequence, callbacks, undefined, options,
          () => preparation?.markLoaded(sequence)),
        play(pitches, velocity, durationMs) {
          const durationSeconds = Math.max(0.001, durationMs / 1000);
          const sequence: PlaybackSequence = { durationSeconds, pedalInitiallyDown: false, pedalEvents: [], events: [
            { sourceNoteId: 'preview', startSeconds: 0, durationSeconds, pitches: [...pitches] },
          ] };
          player.startSequence(sequence, { ended: () => {}, failed: error => console.error('Audio preview:', error) },
            velocity, undefined, () => preparation?.markLoaded(sequence, velocity));
        },
        setSustainPedal(down) {
          void context.resume().then(() => synth.controllerChange(0, 64 as Parameters<typeof synth.controllerChange>[1], down ? 127 : 0))
            .catch((error: unknown) => console.error('Sustain pedal:', error));
        },
        stop: player.stop,
        dispose() {
          player.stop();
          sequencer.eventHandler.removeEvent('songChange', 'clavierdesk');
          sequencer.eventHandler.removeEvent('songEnded', 'clavierdesk');
          sequencer.eventHandler.removeEvent('midiError', 'clavierdesk');
          batch?.reject(new Error('Piano audio was closed.'));
          batch = undefined;
          preloader?.eventHandler.removeEvent('songChange', 'sample-preparation');
          preloader?.eventHandler.removeEvent('midiError', 'sample-preparation');
          synth.destroy();
          void context.close();
        },
      };
    } catch (error) {
      await context.close();
      throw error;
    }
  }
}

export default SpessaSynthInstrument;
