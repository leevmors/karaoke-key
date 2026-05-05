// Phase vocoder pitch-shift AudioWorkletProcessor.
//
// Standard FFT-based time-preserving pitch shift (Bernsee/Ellis-style):
//   1. STFT with periodic Hann window, 75% overlap (FRAME 2048 / HOP 512).
//   2. Per-bin true-frequency estimate via phase-advance tracking on ch0.
//   3. Spectral resampling (reverse-map with bilinear interpolation).
//   4. Continuous-phase synthesis SHARED across channels, with each channel's
//      inter-channel phase delta re-injected to preserve stereo image.
//   5. Hann² OLA reconstruction (scale 2/3 for unity gain at 75% overlap).
//
// Stereo handling rationale: processing L and R with independent synthesis
// phases lets them drift apart over frames, decorrelating mono content into
// artificial stereo width. Sharing the synthesis phase + re-injecting the
// current frame's inter-channel delta keeps the spatial image intact.
//
// External interface unchanged:
//   port -> processor:  { type: "set-pitch-semitones", value: number }
//                       { type: "shutdown" }
//   processor -> port:  { type: "rms", rms: number }   (every ~250 ms)

const FRAME_SIZE = 2048;
const HOP_SIZE = 512;
const HALF_FRAME = FRAME_SIZE / 2;
const LOG2_FRAME = 11;
const RING_SIZE = FRAME_SIZE * 2; // 4096, power of 2
const RING_MASK = RING_SIZE - 1;

const OUTPUT_SCALE = 2 / 3; // periodic Hann² at 75% overlap → 1.5; invert.
const TWO_PI = 2 * Math.PI;
const RMS_REPORT_SAMPLES = 12000;

class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // ---- Precomputed read-only tables ----
    this.window = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / FRAME_SIZE);
    }

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

    this.twR = new Float32Array(FRAME_SIZE);
    this.twI = new Float32Array(FRAME_SIZE);
    for (let k = 0; k < FRAME_SIZE; k++) {
      const a = (TWO_PI * k) / FRAME_SIZE;
      this.twR[k] = Math.cos(a);
      this.twI[k] = -Math.sin(a);
    }

    this.expectedPhaseAdvance = new Float32Array(HALF_FRAME + 1);
    for (let k = 0; k <= HALF_FRAME; k++) {
      this.expectedPhaseAdvance[k] = (TWO_PI * k * HOP_SIZE) / FRAME_SIZE;
    }

    // ---- Shared scratch (one FFT at a time across all channels) ----
    this.fftRe = new Float32Array(FRAME_SIZE);
    this.fftIm = new Float32Array(FRAME_SIZE);
    this.trueBinArr = new Float32Array(HALF_FRAME + 1);
    this.synFreq = new Float32Array(HALF_FRAME + 1); // rad/sample
    this.dominantBin = new Int16Array(HALF_FRAME + 1);

    // ---- Shared analysis/synthesis state ----
    this.hopCounter = 0;
    this.lastPhase = new Float32Array(HALF_FRAME + 1); // ch0 only
    this.synPhase = new Float32Array(HALF_FRAME + 1);  // shared across channels

    // ---- Lazy per-channel scratch (mag + phase per analysis frame, plus
    //      reverse-mapped synthesis magnitudes) ----
    this.magByCh = [];
    this.phaseByCh = [];
    this.synMagByCh = [];

    // ---- Per-channel ring buffers ----
    this.channelStates = [];

    // ---- Pitch ratio ----
    this.ratio = 1;
    this.pendingRatio = 1;

    // ---- RMS reporting ----
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
      outWriteRefIdx: FRAME_SIZE,
    };
  }

  ensureChannelScratch(numCh) {
    while (this.magByCh.length < numCh) {
      this.magByCh.push(new Float32Array(HALF_FRAME + 1));
      this.phaseByCh.push(new Float32Array(HALF_FRAME + 1));
      this.synMagByCh.push(new Float32Array(HALF_FRAME + 1));
    }
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

  // Inverse FFT via the conjugate trick.
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

  processFrame(numCh, ratio) {
    const re = this.fftRe;
    const im = this.fftIm;
    const win = this.window;
    const expected = this.expectedPhaseAdvance;
    const lastPhase = this.lastPhase;
    const synPhase = this.synPhase;
    const synFreq = this.synFreq;
    const trueBinArr = this.trueBinArr;
    const dominantBin = this.dominantBin;

    // ---- 1. FFT each channel; store mag + phase ----
    for (let c = 0; c < numCh; c++) {
      const state = this.channelStates[c];
      const inRing = state.inRing;
      const readStart = (state.inWriteIdx - FRAME_SIZE + RING_SIZE) & RING_MASK;
      for (let i = 0; i < FRAME_SIZE; i++) {
        re[i] = inRing[(readStart + i) & RING_MASK] * win[i];
        im[i] = 0;
      }
      this.fft(re, im);

      const mag = this.magByCh[c];
      const phase = this.phaseByCh[c];
      for (let k = 0; k <= HALF_FRAME; k++) {
        const reK = re[k];
        const imK = im[k];
        mag[k] = Math.sqrt(reK * reK + imK * imK);
        phase[k] = Math.atan2(imK, reK);
      }
    }

    // ---- 2. True frequency from ch0's phase advance ----
    const phase0 = this.phaseByCh[0];
    for (let k = 0; k <= HALF_FRAME; k++) {
      let dPhase = phase0[k] - lastPhase[k];
      lastPhase[k] = phase0[k];
      dPhase -= expected[k];
      dPhase -= TWO_PI * Math.round(dPhase / TWO_PI);
      trueBinArr[k] = k + (dPhase * FRAME_SIZE) / (TWO_PI * HOP_SIZE);
    }

    // ---- 3. Reverse-map ch0 spectrum: synMag0, synFreq, dominantBin ----
    const mag0 = this.magByCh[0];
    const synMag0 = this.synMagByCh[0];
    for (let k2 = 0; k2 <= HALF_FRAME; k2++) {
      const kSrc = k2 / ratio;
      const k0i = Math.floor(kSrc);
      const k1i = k0i + 1;
      const frac = kSrc - k0i;

      let mag = 0;
      let dom = k0i;
      if (k0i >= 0 && k0i <= HALF_FRAME) mag += mag0[k0i] * (1 - frac);
      if (k1i >= 0 && k1i <= HALF_FRAME) {
        mag += mag0[k1i] * frac;
        if (frac > 0.5) dom = k1i;
      }
      synMag0[k2] = mag;
      const domClamped = dom < 0 ? 0 : dom > HALF_FRAME ? HALF_FRAME : dom;
      dominantBin[k2] = domClamped;
      synFreq[k2] = (TWO_PI * trueBinArr[domClamped] * ratio) / FRAME_SIZE;
    }

    // ---- 4. Reverse-map magnitudes for additional channels ----
    for (let c = 1; c < numCh; c++) {
      const magC = this.magByCh[c];
      const synMagC = this.synMagByCh[c];
      for (let k2 = 0; k2 <= HALF_FRAME; k2++) {
        const kSrc = k2 / ratio;
        const k0i = Math.floor(kSrc);
        const k1i = k0i + 1;
        const frac = kSrc - k0i;
        let mag = 0;
        if (k0i >= 0 && k0i <= HALF_FRAME) mag += magC[k0i] * (1 - frac);
        if (k1i >= 0 && k1i <= HALF_FRAME) mag += magC[k1i] * frac;
        synMagC[k2] = mag;
      }
    }

    // ---- 5. Advance shared synthesis phase ----
    for (let k = 0; k <= HALF_FRAME; k++) {
      let ph = synPhase[k] + synFreq[k] * HOP_SIZE;
      if (ph > 1e6 || ph < -1e6) {
        ph -= TWO_PI * Math.round(ph / TWO_PI);
      }
      synPhase[k] = ph;
    }

    // ---- 6. Synthesize each channel, OLA into its outRing ----
    for (let c = 0; c < numCh; c++) {
      const synMagC = this.synMagByCh[c];

      if (c === 0) {
        for (let k = 0; k <= HALF_FRAME; k++) {
          const m = synMagC[k];
          const ph = synPhase[k];
          re[k] = m * Math.cos(ph);
          im[k] = m * Math.sin(ph);
        }
      } else {
        // Re-inject input's inter-channel phase delta from the dominant
        // source bin so the stereo image survives the pitch shift.
        const phaseC = this.phaseByCh[c];
        for (let k = 0; k <= HALF_FRAME; k++) {
          const dom = dominantBin[k];
          const interDelta = phaseC[dom] - phase0[dom];
          const ph = synPhase[k] + interDelta;
          const m = synMagC[k];
          re[k] = m * Math.cos(ph);
          im[k] = m * Math.sin(ph);
        }
      }

      // Hermitian symmetry for real output.
      for (let k = 1; k < HALF_FRAME; k++) {
        re[FRAME_SIZE - k] = re[k];
        im[FRAME_SIZE - k] = -im[k];
      }
      im[0] = 0;
      im[HALF_FRAME] = 0;

      this.ifft(re, im);

      const state = this.channelStates[c];
      const outRing = state.outRing;
      const writeStart = state.outWriteRefIdx;
      for (let i = 0; i < FRAME_SIZE; i++) {
        outRing[(writeStart + i) & RING_MASK] += re[i] * win[i] * OUTPUT_SCALE;
      }
      state.outWriteRefIdx = (state.outWriteRefIdx + HOP_SIZE) & RING_MASK;
    }
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
    this.ensureChannelScratch(outCh);

    this.ratio = this.pendingRatio;
    const ratio = this.ratio;

    for (let i = 0; i < blockLen; i++) {
      // Per-channel I/O each sample.
      for (let c = 0; c < outCh; c++) {
        const state = this.channelStates[c];
        const srcCh = inCh > 0 ? input[Math.min(c, inCh - 1)] : null;
        const s = srcCh ? srcCh[i] : 0;

        if (c === 0) {
          this.rmsAcc += s * s;
          this.rmsN++;
        }

        state.inRing[state.inWriteIdx] = s;
        state.inWriteIdx = (state.inWriteIdx + 1) & RING_MASK;

        const outSample = state.outRing[state.outReadIdx];
        state.outRing[state.outReadIdx] = 0;
        state.outReadIdx = (state.outReadIdx + 1) & RING_MASK;
        output[c][i] = outSample;
      }

      // One shared hop counter drives all channels in lockstep.
      this.hopCounter++;
      if (this.hopCounter >= HOP_SIZE) {
        this.hopCounter = 0;
        this.processFrame(outCh, ratio);
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
