// Phase vocoder pitch-shift AudioWorkletProcessor.
//
// Standard FFT-based time-preserving pitch shift (Bernsee/Ellis-style):
//   1. STFT with periodic Hann window, 75% overlap (FRAME 2048 / HOP 512).
//   2. Per-bin true-frequency estimate via phase-advance tracking.
//   3. Spectral resampling (reverse-map with bilinear interpolation).
//   4. Continuous-phase synthesis, window again, overlap-add into ring buffer.
//
// External interface unchanged from the previous granular worklet:
//   port -> processor:  { type: "set-pitch-semitones", value: number }
//                       { type: "shutdown" }
//   processor -> port:  { type: "rms", rms: number }   (every ~250 ms)

const FRAME_SIZE = 2048;
const HOP_SIZE = 512;
const HALF_FRAME = FRAME_SIZE / 2;
const LOG2_FRAME = 11;
const RING_SIZE = FRAME_SIZE * 2; // 4096, power of 2
const RING_MASK = RING_SIZE - 1;

// OLA reconstruction gain for periodic Hann² at 75% overlap is 1.5.
// Scale synthesis by 2/3 to recover unity gain.
const OUTPUT_SCALE = 2 / 3;

const TWO_PI = 2 * Math.PI;
const RMS_REPORT_SAMPLES = 12000;

class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Periodic Hann window (used at both analysis and synthesis).
    this.window = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / FRAME_SIZE);
    }

    // Bit-reversal table for in-place radix-2 FFT.
    this.brTable = new Uint16Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      let j = 0;
      let x = i;
      for (let b = 0; b < LOG2_FRAME; b++) {
        j = (j << 1) | (x & 1);
        x >>>= 1;
      }
      this.brTable[i] = j;
    }

    // Forward-FFT twiddle factors: exp(-i 2π k / N).
    this.twR = new Float32Array(FRAME_SIZE);
    this.twI = new Float32Array(FRAME_SIZE);
    for (let k = 0; k < FRAME_SIZE; k++) {
      const a = (TWO_PI * k) / FRAME_SIZE;
      this.twR[k] = Math.cos(a);
      this.twI[k] = -Math.sin(a);
    }

    // Expected phase advance per bin over HOP samples.
    this.expectedPhaseAdvance = new Float32Array(HALF_FRAME + 1);
    for (let k = 0; k <= HALF_FRAME; k++) {
      this.expectedPhaseAdvance[k] = (TWO_PI * k * HOP_SIZE) / FRAME_SIZE;
    }

    // Scratch buffers (reused across channels within a single processFrame).
    this.fftRe = new Float32Array(FRAME_SIZE);
    this.fftIm = new Float32Array(FRAME_SIZE);
    this.magArr = new Float32Array(HALF_FRAME + 1);
    this.trueBinArr = new Float32Array(HALF_FRAME + 1);
    this.synMag = new Float32Array(HALF_FRAME + 1);
    this.synFreq = new Float32Array(HALF_FRAME + 1); // radians/sample

    this.channelStates = [];

    this.ratio = 1;
    this.pendingRatio = 1;

    this.rmsAcc = 0;
    this.rmsN = 0;
    this.alive = true;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "set-pitch-semitones") {
        const s = Number(data.value) || 0;
        this.pendingRatio = Math.pow(2, s / 12);
      } else if (data.type === "shutdown") {
        this.alive = false;
      }
    };
  }

  initChannel() {
    return {
      inRing: new Float32Array(RING_SIZE),
      outRing: new Float32Array(RING_SIZE),
      inWriteIdx: 0,
      outReadIdx: 0,
      // First synthesis OLA writes FRAME_SIZE samples ahead of read pointer.
      // First FRAME_SIZE samples of output are silence (algorithmic latency).
      outWriteRefIdx: FRAME_SIZE,
      hopCounter: 0,
      lastPhase: new Float32Array(HALF_FRAME + 1),
      synPhase: new Float32Array(HALF_FRAME + 1),
    };
  }

  // In-place radix-2 Cooley–Tukey FFT.
  fft(re, im) {
    const N = FRAME_SIZE;
    const br = this.brTable;
    const twR = this.twR;
    const twI = this.twI;

    for (let i = 0; i < N; i++) {
      const j = br[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }

    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = N / size;
      for (let i = 0; i < N; i += size) {
        let k = 0;
        for (let j = i; j < i + half; j++) {
          const cR = twR[k];
          const cI = twI[k];
          const reJh = re[j + half];
          const imJh = im[j + half];
          const tR = reJh * cR - imJh * cI;
          const tI = reJh * cI + imJh * cR;
          re[j + half] = re[j] - tR;
          im[j + half] = im[j] - tI;
          re[j] += tR;
          im[j] += tI;
          k += step;
        }
      }
    }
  }

  // Inverse FFT via the conjugate trick (forward FFT on conjugated input,
  // then conjugate and divide by N).
  ifft(re, im) {
    const N = FRAME_SIZE;
    for (let i = 0; i < N; i++) im[i] = -im[i];
    this.fft(re, im);
    const inv = 1 / N;
    for (let i = 0; i < N; i++) {
      re[i] *= inv;
      im[i] = -im[i] * inv;
    }
  }

  processFrame(state, ratio) {
    const re = this.fftRe;
    const im = this.fftIm;
    const magArr = this.magArr;
    const trueBinArr = this.trueBinArr;
    const synMag = this.synMag;
    const synFreq = this.synFreq;
    const win = this.window;
    const inRing = state.inRing;
    const outRing = state.outRing;
    const lastPhase = state.lastPhase;
    const expected = this.expectedPhaseAdvance;

    // 1. Pull windowed input frame ending at inWriteIdx.
    const readStart = (state.inWriteIdx - FRAME_SIZE + RING_SIZE) & RING_MASK;
    for (let i = 0; i < FRAME_SIZE; i++) {
      re[i] = inRing[(readStart + i) & RING_MASK] * win[i];
      im[i] = 0;
    }

    // 2. Forward FFT.
    this.fft(re, im);

    // 3. Per analysis bin: magnitude + true-frequency from phase advance.
    for (let k = 0; k <= HALF_FRAME; k++) {
      const reK = re[k];
      const imK = im[k];
      const mag = Math.sqrt(reK * reK + imK * imK);
      const phase = Math.atan2(imK, reK);

      let dPhase = phase - lastPhase[k];
      lastPhase[k] = phase;

      // Subtract expected advance, then wrap to (-π, π].
      dPhase -= expected[k];
      dPhase -= TWO_PI * Math.round(dPhase / TWO_PI);

      // True bin index (continuous): k + dPhase·N/(2π·H)
      const trueBin = k + (dPhase * FRAME_SIZE) / (TWO_PI * HOP_SIZE);

      magArr[k] = mag;
      trueBinArr[k] = trueBin;
    }

    // 4. Reverse-map with bilinear interpolation.
    //    For each output bin k2, sample input spectrum at kSrc = k2/ratio.
    for (let k2 = 0; k2 <= HALF_FRAME; k2++) {
      const kSrc = k2 / ratio;
      const k0 = Math.floor(kSrc);
      const k1 = k0 + 1;
      const frac = kSrc - k0;

      let mag = 0;
      let dominant = k0;
      if (k0 >= 0 && k0 <= HALF_FRAME) {
        mag += magArr[k0] * (1 - frac);
      }
      if (k1 >= 0 && k1 <= HALF_FRAME) {
        mag += magArr[k1] * frac;
        if (frac > 0.5) dominant = k1;
      }

      const dom =
        dominant >= 0 && dominant <= HALF_FRAME ? trueBinArr[dominant] : 0;

      synMag[k2] = mag;
      // Synthesis angular frequency = 2π · trueBin · ratio / N (rad/sample).
      synFreq[k2] = (TWO_PI * dom * ratio) / FRAME_SIZE;
    }

    // 5. Advance synthesis phase, build output spectrum.
    for (let k = 0; k <= HALF_FRAME; k++) {
      let ph = state.synPhase[k] + synFreq[k] * HOP_SIZE;
      // Keep numerically bounded (cos/sin are fine for huge values, but
      // accumulating drift over many frames is wasteful).
      if (ph > 1e6 || ph < -1e6) {
        ph -= TWO_PI * Math.round(ph / TWO_PI);
      }
      state.synPhase[k] = ph;

      const m = synMag[k];
      re[k] = m * Math.cos(ph);
      im[k] = m * Math.sin(ph);
    }

    // 6. Hermitian symmetry for real output.
    for (let k = 1; k < HALF_FRAME; k++) {
      re[FRAME_SIZE - k] = re[k];
      im[FRAME_SIZE - k] = -im[k];
    }
    im[0] = 0;
    im[HALF_FRAME] = 0;

    // 7. Inverse FFT.
    this.ifft(re, im);

    // 8. Synthesis-window output and overlap-add into the output ring.
    const writeStart = state.outWriteRefIdx;
    for (let i = 0; i < FRAME_SIZE; i++) {
      outRing[(writeStart + i) & RING_MASK] += re[i] * win[i] * OUTPUT_SCALE;
    }

    state.outWriteRefIdx = (state.outWriteRefIdx + HOP_SIZE) & RING_MASK;
  }

  process(inputs, outputs) {
    if (!this.alive) return false;

    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outCh = output.length;
    const inCh = input ? input.length : 0;
    const blockLen = output[0].length;

    while (this.channelStates.length < outCh) {
      this.channelStates.push(this.initChannel());
    }

    // Latch new ratio at the process boundary.
    this.ratio = this.pendingRatio;
    const ratio = this.ratio;

    for (let i = 0; i < blockLen; i++) {
      for (let c = 0; c < outCh; c++) {
        const state = this.channelStates[c];
        const srcCh = inCh > 0 ? input[Math.min(c, inCh - 1)] : null;
        const s = srcCh ? srcCh[i] : 0;

        if (c === 0) {
          this.rmsAcc += s * s;
          this.rmsN++;
        }

        // Always feed the input ring to keep state warm.
        state.inRing[state.inWriteIdx] = s;
        state.inWriteIdx = (state.inWriteIdx + 1) & RING_MASK;

        // Drain output ring (zero out as we go so future OLA accumulates clean).
        const outSample = state.outRing[state.outReadIdx];
        state.outRing[state.outReadIdx] = 0;
        state.outReadIdx = (state.outReadIdx + 1) & RING_MASK;
        output[c][i] = outSample;

        // Trigger an analysis frame every HOP_SIZE input samples.
        state.hopCounter++;
        if (state.hopCounter >= HOP_SIZE) {
          state.hopCounter = 0;
          this.processFrame(state, ratio);
        }
      }
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
