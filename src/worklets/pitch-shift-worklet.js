// Granular pitch-shifter AudioWorkletProcessor.
// Two read heads crossfaded with Hann windows offset by half the grain.
// Hann_A(x) + Hann_A(x + N/2) = 1 across the grain, so amplitude is preserved.
// Time is preserved by restarting each grain at a fixed lookback from the write head.

const GRAIN_SIZE = 2048;
const HALF_GRAIN = GRAIN_SIZE >> 1;
const BUF_SIZE = 16384;
const RMS_REPORT_SAMPLES = 12000;

class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = 1;
    this.bufs = null;
    this.writeIdx = 0;
    this.readPos = [0, HALF_GRAIN];
    this.grainPhase = [0, HALF_GRAIN];
    this.rmsAcc = 0;
    this.rmsN = 0;
    this.alive = true;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "set-pitch-semitones") {
        const s = Number(data.value) || 0;
        this.ratio = Math.pow(2, s / 12);
      } else if (data.type === "shutdown") {
        this.alive = false;
      }
    };
  }

  process(inputs, outputs) {
    if (!this.alive) return false;

    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outCh = output.length;
    const inCh = input ? input.length : 0;
    const blockLen = output[0].length;

    if (!this.bufs || this.bufs.length !== outCh) {
      this.bufs = [];
      for (let c = 0; c < outCh; c++) {
        this.bufs.push(new Float32Array(BUF_SIZE));
      }
    }

    const lookback = Math.max(1, Math.ceil(GRAIN_SIZE * Math.max(this.ratio, 1) + 8));

    for (let i = 0; i < blockLen; i++) {
      // Write incoming sample(s); mirror mono to stereo when needed.
      for (let c = 0; c < outCh; c++) {
        const srcCh = inCh > 0 ? input[Math.min(c, inCh - 1)] : null;
        const s = srcCh ? srcCh[i] : 0;
        this.bufs[c][this.writeIdx] = s;
        if (c === 0) {
          this.rmsAcc += s * s;
          this.rmsN++;
        }
      }
      const writeIdxBefore = this.writeIdx;
      this.writeIdx = (this.writeIdx + 1) % BUF_SIZE;

      // Read two grains, sum with Hann crossfade.
      let out0 = 0;
      let out1 = 0;
      for (let g = 0; g < 2; g++) {
        const phase = this.grainPhase[g];
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * phase) / GRAIN_SIZE);

        let rp = this.readPos[g];
        // Bring into [0, BUF_SIZE) without modulo on negatives.
        rp = ((rp % BUF_SIZE) + BUF_SIZE) % BUF_SIZE;
        const i0 = Math.floor(rp);
        const frac = rp - i0;
        const i1 = (i0 + 1) % BUF_SIZE;

        if (outCh >= 1) {
          const b = this.bufs[0];
          out0 += (b[i0] + (b[i1] - b[i0]) * frac) * w;
        }
        if (outCh >= 2) {
          const b = this.bufs[1];
          out1 += (b[i0] + (b[i1] - b[i0]) * frac) * w;
        }

        this.readPos[g] = rp + this.ratio;
        this.grainPhase[g]++;
        if (this.grainPhase[g] >= GRAIN_SIZE) {
          this.grainPhase[g] = 0;
          let start = writeIdxBefore - lookback;
          start = ((start % BUF_SIZE) + BUF_SIZE) % BUF_SIZE;
          this.readPos[g] = start;
        }
      }

      output[0][i] = out0;
      if (outCh >= 2) output[1][i] = out1;
    }

    if (this.rmsN >= RMS_REPORT_SAMPLES) {
      const rms = Math.sqrt(this.rmsAcc / this.rmsN);
      this.port.postMessage({ type: "rms", rms });
      this.rmsAcc = 0;
      this.rmsN = 0;
    }

    return true;
  }
}

registerProcessor("pitch-shift-processor", PitchShiftProcessor);
