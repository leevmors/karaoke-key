// Pitch-shift AudioWorkletProcessor with two quality modes.
//
// MODE = "heavy" (default):
//   • Mid/Side time-domain routing: M=(L+R)/2, S=(L-R)/2.
//   • Two fully independent mono phase-vocoder cores (one for M, one for S).
//   • Identity phase locking inside each core: peak bins drive the synthesis
//     phase trajectory; non-peak bins lock to their nearest peak with the
//     input frame's intra-frame phase relationship preserved.
//   • Result: zero L/R decorrelation (mathematical guarantee for mono input)
//     plus no PV "phasey" comb-filter sound on sustained partials.
//
// MODE = "light":
//   • Per-channel ring buffers, shared synthesis phase, per-frame
//     inter-channel phase delta injection. (The previous shipping algorithm.)
//   • Lower CPU; mild stereo bleed and slight PV phasiness are accepted
//     trade-offs.
//
// External interface:
//   port -> processor:  { type: "set-pitch-semitones", value: number }
//                       { type: "set-mode", value: "heavy" | "light" }
//                       { type: "shutdown" }
//   processor -> port:  { type: "rms", rms: number }   (every ~250 ms)

const FRAME_SIZE = 2048;
const HOP_SIZE = 512;
const HALF_FRAME = FRAME_SIZE / 2;
const LOG2_FRAME = 11;
const RING_SIZE = FRAME_SIZE * 2; // 4096, power of 2
const RING_MASK = RING_SIZE - 1;

const OUTPUT_SCALE = 2 / 3; // periodic Hann² OLA at 75% overlap → 1.5; invert.
const TWO_PI = 2 * Math.PI;
const RMS_REPORT_SAMPLES = 12000;

// Phase-locking peak threshold relative to the frame's max magnitude.
const PEAK_THRESHOLD_REL = 1e-4;

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

    // ---- Shared scratch (used by whichever path is active) ----
    this.fftRe = new Float32Array(FRAME_SIZE);
    this.fftIm = new Float32Array(FRAME_SIZE);
    this.magArr = new Float32Array(HALF_FRAME + 1);
    this.phaseArr = new Float32Array(HALF_FRAME + 1);
    this.trueBinArr = new Float32Array(HALF_FRAME + 1);
    this.synFreq = new Float32Array(HALF_FRAME + 1);
    this.dominantBin = new Int16Array(HALF_FRAME + 1);
    this.peakOf = new Int16Array(HALF_FRAME + 1);

    // ---- Light-path state (the previous shipping algorithm) ----
    this.lightHopCounter = 0;
    this.lightLastPhase = new Float32Array(HALF_FRAME + 1); // ch0 only
    this.lightSynPhase = new Float32Array(HALF_FRAME + 1);
    this.lightChannels = [];
    this.lightMagByCh = [];
    this.lightPhaseByCh = [];
    this.lightSynMagByCh = [];

    // ---- Heavy-path state: two independent mono cores (M and S) ----
    this.coreM = this.makeCore();
    this.coreS = this.makeCore();

    // ---- Pitch ratio ----
    this.ratio = 1;
    this.pendingRatio = 1;

    // ---- Mode ----
    this.mode = "heavy";

    // ---- RMS reporting ----
    this.rmsAcc = 0;
    this.rmsN = 0;
    this.alive = true;

    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "set-pitch-semitones") {
        const s = Number(data.value) || 0;
        this.pendingRatio = Math.pow(2, s / 12);
      } else if (data.type === "set-mode") {
        const next = data.value === "light" ? "light" : "heavy";
        if (next !== this.mode) {
          this.mode = next;
          // Reset state of the path we're switching INTO so we start clean.
          if (next === "heavy") {
            this.resetCore(this.coreM);
            this.resetCore(this.coreS);
          } else {
            this.resetLight();
          }
        }
      } else if (data.type === "shutdown") {
        this.alive = false;
      }
    };
  }

  // -------- Heavy path helpers --------

  makeCore() {
    return {
      inRing: new Float32Array(RING_SIZE),
      outRing: new Float32Array(RING_SIZE),
      inWriteIdx: 0,
      outReadIdx: 0,
      outWriteRefIdx: FRAME_SIZE,
      hopCounter: 0,
      lastPhase: new Float32Array(HALF_FRAME + 1),
      synPhase: new Float32Array(HALF_FRAME + 1),
    };
  }

  resetCore(core) {
    core.inRing.fill(0);
    core.outRing.fill(0);
    core.inWriteIdx = 0;
    core.outReadIdx = 0;
    core.outWriteRefIdx = FRAME_SIZE;
    core.hopCounter = 0;
    core.lastPhase.fill(0);
    core.synPhase.fill(0);
  }

  resetLight() {
    this.lightHopCounter = 0;
    this.lightLastPhase.fill(0);
    this.lightSynPhase.fill(0);
    for (const s of this.lightChannels) {
      s.inRing.fill(0);
      s.outRing.fill(0);
      s.inWriteIdx = 0;
      s.outReadIdx = 0;
      s.outWriteRefIdx = FRAME_SIZE;
    }
  }

  // -------- FFT / IFFT (shared) --------

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

  // -------- Heavy path: per-core analysis + phase-locked synthesis --------

  // One sample step for a single mono PV core.
  stepCore(core, sample, ratio) {
    core.inRing[core.inWriteIdx] = sample;
    core.inWriteIdx = (core.inWriteIdx + 1) & RING_MASK;

    const out = core.outRing[core.outReadIdx];
    core.outRing[core.outReadIdx] = 0;
    core.outReadIdx = (core.outReadIdx + 1) & RING_MASK;

    if (++core.hopCounter >= HOP_SIZE) {
      core.hopCounter = 0;
      this.processFrameLocked(core, ratio);
    }
    return out;
  }

  processFrameLocked(core, ratio) {
    const re = this.fftRe;
    const im = this.fftIm;
    const win = this.window;
    const expected = this.expectedPhaseAdvance;
    const magArr = this.magArr;
    const phaseArr = this.phaseArr;
    const trueBinArr = this.trueBinArr;
    const synFreq = this.synFreq;
    const dominantBin = this.dominantBin;
    const peakOf = this.peakOf;
    const lastPhase = core.lastPhase;
    const synPhase = core.synPhase;

    // 1. Window the most recent FRAME_SIZE samples.
    const readStart = (core.inWriteIdx - FRAME_SIZE + RING_SIZE) & RING_MASK;
    for (let i = 0; i < FRAME_SIZE; i++) {
      re[i] = core.inRing[(readStart + i) & RING_MASK] * win[i];
      im[i] = 0;
    }

    // 2. Forward FFT.
    this.fft(re, im);

    // 3. Magnitude + phase, plus true-frequency from phase advance.
    let maxMag = 0;
    for (let k = 0; k <= HALF_FRAME; k++) {
      const reK = re[k];
      const imK = im[k];
      const mag = Math.sqrt(reK * reK + imK * imK);
      const phase = Math.atan2(imK, reK);
      magArr[k] = mag;
      phaseArr[k] = phase;
      if (mag > maxMag) maxMag = mag;

      let dPhase = phase - lastPhase[k];
      lastPhase[k] = phase;
      dPhase -= expected[k];
      dPhase -= TWO_PI * Math.round(dPhase / TWO_PI);
      trueBinArr[k] = k + (dPhase * FRAME_SIZE) / (TWO_PI * HOP_SIZE);
    }

    // 4. Reverse-map into output bins (mag, synFreq, dominantBin).
    for (let k2 = 0; k2 <= HALF_FRAME; k2++) {
      const kSrc = k2 / ratio;
      const k0 = Math.floor(kSrc);
      const k1 = k0 + 1;
      const frac = kSrc - k0;

      let mag = 0;
      let dom = k0;
      if (k0 >= 0 && k0 <= HALF_FRAME) mag += magArr[k0] * (1 - frac);
      if (k1 >= 0 && k1 <= HALF_FRAME) {
        mag += magArr[k1] * frac;
        if (frac > 0.5) dom = k1;
      }
      const domClamped = dom < 0 ? 0 : dom > HALF_FRAME ? HALF_FRAME : dom;
      // Reuse magArr slot? No, we still need original mags. Stash in synFreq
      // temporarily? Cleaner: write final synthesis mag back over magArr would
      // wreck phase-locking. Use a fresh small buffer via the synthesis path.
      // Decision: stash the OUTPUT magnitudes in dominantBin's mag-by-bin via
      // a separate array. We don't have one — write synthesis mag into the
      // frequency-domain re[] slot, then overwrite re[] during step 6.
      re[k2] = mag; // temporary holding for output magnitude
      dominantBin[k2] = domClamped;
      synFreq[k2] = (TWO_PI * trueBinArr[domClamped] * ratio) / FRAME_SIZE;
    }

    // 5. Identity phase locking.
    //
    // 5a. Find peaks in the INPUT magnitude spectrum (not the reverse-mapped
    //     output magnitudes). Peaks track partials of the original signal.
    const peakThreshold = maxMag * PEAK_THRESHOLD_REL;
    // Build peakOf[k] = index of nearest peak bin to k.
    // First sweep left→right marking peaks; non-peaks get the most recent
    // peak. Then sweep right→left, picking the closer of the two.
    let lastPeak = -1;
    for (let k = 0; k <= HALF_FRAME; k++) {
      const isPeak =
        magArr[k] > peakThreshold &&
        (k === 0 || magArr[k] > magArr[k - 1]) &&
        (k === HALF_FRAME || magArr[k] > magArr[k + 1]);
      if (isPeak) {
        lastPeak = k;
      }
      peakOf[k] = lastPeak; // -1 if no peak yet
    }
    // Right-to-left: pick the nearer peak.
    let nextPeak = -1;
    for (let k = HALF_FRAME; k >= 0; k--) {
      const isPeak =
        magArr[k] > peakThreshold &&
        (k === 0 || magArr[k] > magArr[k - 1]) &&
        (k === HALF_FRAME || magArr[k] > magArr[k + 1]);
      if (isPeak) {
        nextPeak = k;
      }
      const left = peakOf[k];
      let chosen = nextPeak;
      if (left >= 0 && nextPeak >= 0) {
        chosen = k - left <= nextPeak - k ? left : nextPeak;
      } else if (left >= 0) {
        chosen = left;
      }
      peakOf[k] = chosen; // may still be -1 if no peaks at all in frame
    }

    // 5b. Advance synthesis phase: peaks advance normally, non-peaks lock
    //     to nearest peak's synPhase plus the input's intra-frame delta.
    //     Two-pass to avoid clobbering:
    //       pass 1: compute new synPhase for peaks (in-place ok, peaks first)
    //       pass 2: assign locked phases for non-peaks
    // Mark which bins are peaks via a flag stored in dominantBin's high bit
    // would be hacky; instead, recompute the peak test in-line.
    for (let k = 0; k <= HALF_FRAME; k++) {
      const isPeak =
        magArr[k] > peakThreshold &&
        (k === 0 || magArr[k] > magArr[k - 1]) &&
        (k === HALF_FRAME || magArr[k] > magArr[k + 1]);
      if (isPeak) {
        let ph = synPhase[k] + synFreq[k] * HOP_SIZE;
        if (ph > 1e6 || ph < -1e6) {
          ph -= TWO_PI * Math.round(ph / TWO_PI);
        }
        synPhase[k] = ph;
      }
    }
    // Pass 2: lock non-peaks. Use a temp via synFreq[] slot? synFreq still
    // needed? After phase advance we don't read synFreq again — safe to reuse.
    // But to avoid sequencing bugs, just overwrite synPhase in-place; non-peak
    // bins read peakOf[k] which was pre-resolved.
    for (let k = 0; k <= HALF_FRAME; k++) {
      const isPeak =
        magArr[k] > peakThreshold &&
        (k === 0 || magArr[k] > magArr[k - 1]) &&
        (k === HALF_FRAME || magArr[k] > magArr[k + 1]);
      if (isPeak) continue;
      const p = peakOf[k];
      if (p < 0) {
        // No peaks in frame — let the bin just advance normally.
        let ph = synPhase[k] + synFreq[k] * HOP_SIZE;
        if (ph > 1e6 || ph < -1e6) {
          ph -= TWO_PI * Math.round(ph / TWO_PI);
        }
        synPhase[k] = ph;
      } else {
        // Lock to peak's synthesis phase, preserving input intra-frame delta.
        let ph = synPhase[p] + (phaseArr[k] - phaseArr[p]);
        if (ph > 1e6 || ph < -1e6) {
          ph -= TWO_PI * Math.round(ph / TWO_PI);
        }
        synPhase[k] = ph;
      }
    }

    // 6. Build complex spectrum (output magnitude is in re[k], stashed at step 4).
    for (let k = 0; k <= HALF_FRAME; k++) {
      const m = re[k]; // stashed output magnitude
      const ph = synPhase[k];
      re[k] = m * Math.cos(ph);
      im[k] = m * Math.sin(ph);
    }

    // 7. Hermitian symmetry.
    for (let k = 1; k < HALF_FRAME; k++) {
      re[FRAME_SIZE - k] = re[k];
      im[FRAME_SIZE - k] = -im[k];
    }
    im[0] = 0;
    im[HALF_FRAME] = 0;

    // 8. IFFT + window + OLA.
    this.ifft(re, im);
    const writeStart = core.outWriteRefIdx;
    const outRing = core.outRing;
    for (let i = 0; i < FRAME_SIZE; i++) {
      outRing[(writeStart + i) & RING_MASK] += re[i] * win[i] * OUTPUT_SCALE;
    }
    core.outWriteRefIdx = (core.outWriteRefIdx + HOP_SIZE) & RING_MASK;
  }

  processHeavy(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outCh = output.length;
    const inCh = input ? input.length : 0;
    const blockLen = output[0].length;
    const ratio = this.ratio;

    for (let i = 0; i < blockLen; i++) {
      const L = inCh > 0 ? (input[0] ? input[0][i] : 0) : 0;
      const R =
        inCh > 1 ? (input[1] ? input[1][i] : L) : L;

      // RMS report uses pre-shift L for DRM detection compatibility.
      this.rmsAcc += L * L;
      this.rmsN++;

      const M = (L + R) * 0.5;
      const S = (L - R) * 0.5;

      const Mo = this.stepCore(this.coreM, M, ratio);
      const So = this.stepCore(this.coreS, S, ratio);

      output[0][i] = Mo + So;
      if (outCh > 1) output[1][i] = Mo - So;
    }
    return true;
  }

  // -------- Light path (previous shipping algorithm, kept verbatim) --------

  initLightChannel() {
    return {
      inRing: new Float32Array(RING_SIZE),
      outRing: new Float32Array(RING_SIZE),
      inWriteIdx: 0,
      outReadIdx: 0,
      outWriteRefIdx: FRAME_SIZE,
    };
  }

  ensureLightChannelScratch(numCh) {
    while (this.lightMagByCh.length < numCh) {
      this.lightMagByCh.push(new Float32Array(HALF_FRAME + 1));
      this.lightPhaseByCh.push(new Float32Array(HALF_FRAME + 1));
      this.lightSynMagByCh.push(new Float32Array(HALF_FRAME + 1));
    }
  }

  processLightFrame(numCh, ratio) {
    const re = this.fftRe;
    const im = this.fftIm;
    const win = this.window;
    const expected = this.expectedPhaseAdvance;
    const lastPhase = this.lightLastPhase;
    const synPhase = this.lightSynPhase;
    const synFreq = this.synFreq;
    const trueBinArr = this.trueBinArr;
    const dominantBin = this.dominantBin;

    for (let c = 0; c < numCh; c++) {
      const state = this.lightChannels[c];
      const inRing = state.inRing;
      const readStart = (state.inWriteIdx - FRAME_SIZE + RING_SIZE) & RING_MASK;
      for (let i = 0; i < FRAME_SIZE; i++) {
        re[i] = inRing[(readStart + i) & RING_MASK] * win[i];
        im[i] = 0;
      }
      this.fft(re, im);

      const mag = this.lightMagByCh[c];
      const phase = this.lightPhaseByCh[c];
      for (let k = 0; k <= HALF_FRAME; k++) {
        const reK = re[k];
        const imK = im[k];
        mag[k] = Math.sqrt(reK * reK + imK * imK);
        phase[k] = Math.atan2(imK, reK);
      }
    }

    const phase0 = this.lightPhaseByCh[0];
    for (let k = 0; k <= HALF_FRAME; k++) {
      let dPhase = phase0[k] - lastPhase[k];
      lastPhase[k] = phase0[k];
      dPhase -= expected[k];
      dPhase -= TWO_PI * Math.round(dPhase / TWO_PI);
      trueBinArr[k] = k + (dPhase * FRAME_SIZE) / (TWO_PI * HOP_SIZE);
    }

    const mag0 = this.lightMagByCh[0];
    const synMag0 = this.lightSynMagByCh[0];
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

    for (let c = 1; c < numCh; c++) {
      const magC = this.lightMagByCh[c];
      const synMagC = this.lightSynMagByCh[c];
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

    for (let k = 0; k <= HALF_FRAME; k++) {
      let ph = synPhase[k] + synFreq[k] * HOP_SIZE;
      if (ph > 1e6 || ph < -1e6) {
        ph -= TWO_PI * Math.round(ph / TWO_PI);
      }
      synPhase[k] = ph;
    }

    for (let c = 0; c < numCh; c++) {
      const synMagC = this.lightSynMagByCh[c];
      if (c === 0) {
        for (let k = 0; k <= HALF_FRAME; k++) {
          const m = synMagC[k];
          const ph = synPhase[k];
          re[k] = m * Math.cos(ph);
          im[k] = m * Math.sin(ph);
        }
      } else {
        const phaseC = this.lightPhaseByCh[c];
        for (let k = 0; k <= HALF_FRAME; k++) {
          const dom = dominantBin[k];
          const interDelta = phaseC[dom] - phase0[dom];
          const ph = synPhase[k] + interDelta;
          const m = synMagC[k];
          re[k] = m * Math.cos(ph);
          im[k] = m * Math.sin(ph);
        }
      }

      for (let k = 1; k < HALF_FRAME; k++) {
        re[FRAME_SIZE - k] = re[k];
        im[FRAME_SIZE - k] = -im[k];
      }
      im[0] = 0;
      im[HALF_FRAME] = 0;

      this.ifft(re, im);

      const state = this.lightChannels[c];
      const outRing = state.outRing;
      const writeStart = state.outWriteRefIdx;
      for (let i = 0; i < FRAME_SIZE; i++) {
        outRing[(writeStart + i) & RING_MASK] += re[i] * win[i] * OUTPUT_SCALE;
      }
      state.outWriteRefIdx = (state.outWriteRefIdx + HOP_SIZE) & RING_MASK;
    }
  }

  processLight(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outCh = output.length;
    const inCh = input ? input.length : 0;
    const blockLen = output[0].length;

    while (this.lightChannels.length < outCh) {
      this.lightChannels.push(this.initLightChannel());
    }
    this.ensureLightChannelScratch(outCh);

    const ratio = this.ratio;

    for (let i = 0; i < blockLen; i++) {
      for (let c = 0; c < outCh; c++) {
        const state = this.lightChannels[c];
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

      this.lightHopCounter++;
      if (this.lightHopCounter >= HOP_SIZE) {
        this.lightHopCounter = 0;
        this.processLightFrame(outCh, ratio);
      }
    }
    return true;
  }

  // -------- Top-level dispatch --------

  process(inputs, outputs) {
    if (!this.alive) return false;
    this.ratio = this.pendingRatio;

    const ok =
      this.mode === "light"
        ? this.processLight(inputs, outputs)
        : this.processHeavy(inputs, outputs);

    if (this.rmsN >= RMS_REPORT_SAMPLES) {
      const rms = Math.sqrt(this.rmsAcc / this.rmsN);
      this.port.postMessage({ type: "rms", rms });
      this.rmsAcc = 0;
      this.rmsN = 0;
    }
    return ok;
  }
}

registerProcessor("pitch-shift-processor", PitchShiftProcessor);
