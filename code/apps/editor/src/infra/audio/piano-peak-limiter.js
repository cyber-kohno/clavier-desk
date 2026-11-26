const CEILING = 10 ** (-1 / 20);

class PianoPeakLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lookahead = Math.ceil(sampleRate * 0.005);
    this.delayLeft = new Float32Array(this.lookahead);
    this.delayRight = new Float32Array(this.lookahead);
    this.delayIndex = 0;
    this.attack = 1 - Math.exp(-1 / (sampleRate * 0.0005));
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.075));
    this.gain = 1;
    this.frame = 0;
    this.peaks = new Float32Array(this.lookahead + 2);
    this.peakFrames = new Float64Array(this.peaks.length);
    this.first = 0;
    this.next = 0;
  }

  process([input], [[outputLeft, outputRight]]) {
    const [inputLeft, inputRight] = input ?? [];
    const capacity = this.peaks.length;
    for (let i = 0; i < outputLeft.length; i++) {
      const left = inputLeft?.[i] ?? 0;
      const right = inputRight?.[i] ?? left;
      const peak = Math.max(Math.abs(left), Math.abs(right));
      const delayedLeft = this.delayLeft[this.delayIndex];
      const delayedRight = this.delayRight[this.delayIndex];
      this.delayLeft[this.delayIndex] = left;
      this.delayRight[this.delayIndex] = right;
      this.delayIndex = (this.delayIndex + 1) % this.lookahead;

      // Keep the largest peak in the delay window at the front of the queue.
      while (this.first !== this.next && this.peakFrames[this.first] < this.frame - this.lookahead) {
        this.first = (this.first + 1) % capacity;
      }
      while (this.first !== this.next) {
        const last = (this.next + capacity - 1) % capacity;
        if (this.peaks[last] > peak) break;
        this.next = last;
      }
      this.peaks[this.next] = peak;
      this.peakFrames[this.next] = this.frame++;
      this.next = (this.next + 1) % capacity;

      const target = Math.min(1, CEILING / this.peaks[this.first]);
      const rate = target < this.gain ? this.attack : this.release;
      const delayedPeak = Math.max(Math.abs(delayedLeft), Math.abs(delayedRight));
      this.gain = Math.min(this.gain + (target - this.gain) * rate, CEILING / delayedPeak);
      outputLeft[i] = delayedLeft * this.gain;
      outputRight[i] = delayedRight * this.gain;
    }
    return true;
  }
}

registerProcessor('clavierdesk-piano-peak-limiter', PianoPeakLimiter);
