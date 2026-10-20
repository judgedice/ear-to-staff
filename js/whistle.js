/**
 * Spectral-peak tracker tuned for whistling inside a full mix.
 *
 * A whistle is close to a pure sine: one tall, narrow spectral peak with no
 * subharmonics. Guitar and vocal energy in the same band is made of overtones,
 * so it has energy at f/2, f/3 ... below it. We score every candidate peak on
 * prominence, narrowness, lack of subharmonics, and continuity with the last
 * tracked frequency, then report the best one with a clarity in [0, 1].
 *
 * Same interface as PitchDetector: detect(buf) -> { freq, clarity, rms }.
 */
import { FFT, hannWindow } from './fft.js';

export class WhistleTracker {
  constructor(sampleRate, fftSize = 4096, opts = {}) {
    this.sampleRate = sampleRate;
    this.n = fftSize;
    this.fft = new FFT(fftSize);
    this.window = hannWindow(fftSize);
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    this.mag = new Float32Array(fftSize / 2 + 1);
    this.minFreq = opts.minFreq ?? 800;
    this.maxFreq = opts.maxFreq ?? 4200;
    this.prevFreq = null;
    this.prevAge = 0;
    this.last = null; // debug info for the most recent frame
  }

  detect(buf) {
    const n = this.n, sr = this.sampleRate;
    const re = this.re, im = this.im, mag = this.mag;

    // Use the most recent n samples; zero-pad if the buffer is shorter.
    const offset = Math.max(0, buf.length - n);
    const len = Math.min(n, buf.length);
    re.fill(0); im.fill(0);
    for (let i = 0; i < len; i++) re[i] = buf[offset + i] * this.window[i];
    this.fft.transform(re, im);

    const bins = n / 2;
    for (let k = 0; k <= bins; k++) mag[k] = Math.hypot(re[k], im[k]);

    const binHz = sr / n;
    const kLo = Math.max(2, Math.floor(this.minFreq / binHz));
    const kHi = Math.min(bins - 2, Math.ceil(this.maxFreq / binHz));
    if (kHi - kLo < 8) return { freq: NaN, clarity: 0, rms: 0 };

    // Band level (approximate RMS of a sine that would produce this energy).
    let energy = 0;
    for (let k = kLo; k <= kHi; k++) energy += mag[k] * mag[k];
    const rms = (4 * Math.sqrt(energy)) / (1.22 * n) / Math.SQRT2;

    // Noise floor: median magnitude in band.
    const band = Array.from(mag.subarray(kLo, kHi + 1)).sort((a, b) => a - b);
    const median = Math.max(band[band.length >> 1], 1e-9);

    // Local maxima, ranked by the energy of a +/-3-bin lobe so that a
    // vibrato-smeared whistle competes fairly with steady, narrow overtones.
    const lobe = (k) => {
      let e = 0;
      for (let j = -3; j <= 3; j++) { const kk = k + j; if (kk >= 1 && kk < bins) e += mag[kk] * mag[kk]; }
      return Math.sqrt(e);
    };
    const peaks = [];
    for (let k = kLo + 1; k < kHi; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1] && mag[k] > median * 3) {
        peaks.push({ k, m: lobe(k) });
      }
    }
    if (peaks.length === 0) {
      this._age();
      return { freq: NaN, clarity: 0, rms };
    }
    peaks.sort((a, b) => b.m - a.m);
    const top = peaks.slice(0, 12);
    const medianLobe = median * Math.sqrt(7);

    let best = null;
    this.candidates = [];
    for (const p of top) {
      const k = p.k;
      // Parabolic interpolation on log magnitude for a sub-bin estimate.
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(mag[k] + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
      const denom = a - 2 * b + c;
      const delta = Math.abs(denom) > 1e-12 ? (0.5 * (a - c)) / denom : 0;
      const freq = (k + delta) * binHz;
      const peakMag = Math.exp(b - 0.25 * (a - c) * delta);

      const promDb = 20 * Math.log10(p.m / medianLobe);

      // Narrowness: how much of the nearby energy sits in the lobe (vibrato-tolerant).
      let wide = 0;
      for (let j = -10; j <= 10; j++) {
        const kk = k + j;
        if (kk >= 1 && kk < bins) wide += mag[kk] * mag[kk];
      }
      const narrow = wide > 0 ? (p.m * p.m) / wide : 0;

      // Overtone test. Hypothesise that this peak is harmonic h of some
      // fundamental f/h and look for its siblings (h-2..h+2)*f0, matched by
      // interpolated frequency within +/-40 cents. Three siblings, or both of
      // the two just below, means a harmonic series, so not a whistle.
      const refMag = Math.max(mag[k - 1], mag[k], mag[k + 1]);
      const magNear = (expectedHz) => {
        const kc = Math.round(expectedHz / binHz);
        let bestK = -1, bestM = 0;
        for (let kk = Math.max(2, kc - 3); kk <= Math.min(bins - 2, kc + 3); kk++) {
          if (mag[kk] > mag[kk - 1] && mag[kk] >= mag[kk + 1] && mag[kk] > bestM) { bestM = mag[kk]; bestK = kk; }
        }
        if (bestK < 0) return 0;
        const la = Math.log(mag[bestK - 1] + 1e-12), lb = Math.log(mag[bestK] + 1e-12), lc = Math.log(mag[bestK + 1] + 1e-12);
        const den = la - 2 * lb + lc;
        const d = Math.abs(den) > 1e-12 ? (0.5 * (la - lc)) / den : 0;
        const f = (bestK + d) * binHz;
        return Math.abs(1200 * Math.log2(f / expectedHz)) <= 40 ? lobe(bestK) : 0;
      };
      let isOvertone = false, siblingsFound = 0;
      for (let h = 2; h <= 24 && !isOvertone; h++) {
        const f0 = freq / h;
        if (f0 < 60) break;
        let found = 0, lower = 0, total = 0;
        for (const m of [h - 2, h - 1, h + 1, h + 2]) {
          if (m < 1) continue;
          const fm = m * f0;
          if (fm > (bins - 3) * binHz) continue;
          total++;
          if (magNear(fm) >= 0.5 * p.m) { found++; if (m < h) lower++; }   // sibling lobe within 6 dB of ours
        }
        siblingsFound = Math.max(siblingsFound, found);
        if (found >= 3 || (lower === 2 && h >= 3) || (total <= 3 && found >= 2)) isOvertone = true;
      }
      const subRatio = magNear(freq / 2) / p.m;
      const neighbourRatio = siblingsFound;
      const subDb = 20 * Math.log10(subRatio + 1e-9);

      // Continuity with the previous frame.
      let bonus = 0;
      if (this.prevFreq) {
        const cents = Math.abs(1200 * Math.log2(freq / this.prevFreq));
        bonus = cents < 60 ? 8 : cents < 150 ? 4 : cents < 350 ? 1 : 0;
      }

      let score = Math.min(promDb, 45) + bonus;
      if (isOvertone) score -= 40;                   // part of a harmonic series: not a whistle
      if (narrow < 0.35) score -= 6;                  // not sine-like
      const cand = { freq, score, promDb, subDb, narrow, subRatio, neighbourRatio, isOvertone, lobe: p.m };
      this.candidates.push(cand);
      if (!best || cand.score > best.score) best = cand;
    }

    const clarity = clamp((best.score - 8) / 24, 0, 1);
    this.last = best;
    if (clarity >= 0.4) {
      this.prevFreq = best.freq;
      this.prevAge = 0;
    } else {
      this._age();
    }
    // Report the level of the chosen peak itself (RMS of an equivalent sine),
    // so the noise gate and the level prior judge the whistle, not the whole band.
    const peakRms = (4 * best.lobe) / (1.22 * n) / Math.SQRT2;
    return { freq: clarity > 0 ? best.freq : NaN, clarity, rms: clarity > 0 ? peakRms : rms, bandRms: rms };
  }

  _age() {
    if (this.prevFreq && ++this.prevAge > 12) this.prevFreq = null;
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
