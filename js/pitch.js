/**
 * Monophonic pitch detector using the McLeod Pitch Method (MPM).
 *
 * Computes the normalized square difference function (NSDF) over a window,
 * picks the first significant peak, and refines it with parabolic interpolation.
 * Returns frequency plus a "clarity" value in [0, 1] that says how periodic the
 * signal looked. Noise and silence come back with low clarity.
 */
export class PitchDetector {
  /**
   * @param {number} sampleRate
   * @param {object} [opts]
   * @param {number} [opts.minFreq=55]   lowest detectable pitch (Hz)
   * @param {number} [opts.maxFreq=1600] highest detectable pitch (Hz)
   * @param {number} [opts.peakCutoff=0.9] fraction of the max NSDF peak a candidate must reach
   */
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.minFreq = opts.minFreq ?? 55;
    this.maxFreq = opts.maxFreq ?? 1600;
    this.peakCutoff = opts.peakCutoff ?? 0.9;
    this.nsdf = null;
  }

  /**
   * @param {Float32Array} buf time-domain samples
   * @returns {{freq:number, clarity:number, rms:number}}
   *          freq is NaN when no pitch was found.
   */
  detect(buf) {
    const n = buf.length;
    const minTau = Math.max(2, Math.floor(this.sampleRate / this.maxFreq));
    const maxTau = Math.min(n >> 1, Math.ceil(this.sampleRate / this.minFreq));

    if (!this.nsdf || this.nsdf.length < maxTau + 1) {
      this.nsdf = new Float32Array(maxTau + 1);
    }
    const nsdf = this.nsdf;

    // Prefix sums of squares so m(tau) is O(1) per lag.
    let rmsAcc = 0;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const v = buf[i];
      rmsAcc += v * v;
      prefix[i + 1] = rmsAcc;
    }
    const rms = Math.sqrt(rmsAcc / n);

    if (rms < 1e-5) return { freq: NaN, clarity: 0, rms };

    for (let tau = minTau; tau <= maxTau; tau++) {
      let acf = 0;
      const lim = n - tau;
      for (let i = 0; i < lim; i++) acf += buf[i] * buf[i + tau];
      const m = prefix[lim] + (prefix[n] - prefix[tau]);
      nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
    }

    // Peak picking: find the max between each positive and negative zero crossing.
    const peaks = [];
    let pos = minTau;
    // Skip the initial region while NSDF is still positive (the lag-0 lobe).
    while (pos <= maxTau && nsdf[pos] > 0) pos++;
    while (pos <= maxTau) {
      // advance to next positive crossing
      while (pos <= maxTau && nsdf[pos] <= 0) pos++;
      if (pos > maxTau) break;
      let bestIdx = pos;
      let bestVal = nsdf[pos];
      while (pos <= maxTau && nsdf[pos] > 0) {
        if (nsdf[pos] > bestVal) { bestVal = nsdf[pos]; bestIdx = pos; }
        pos++;
      }
      peaks.push({ idx: bestIdx, val: bestVal });
    }

    if (peaks.length === 0) return { freq: NaN, clarity: 0, rms };

    let maxVal = 0;
    for (const p of peaks) if (p.val > maxVal) maxVal = p.val;
    const threshold = maxVal * this.peakCutoff;
    let chosen = peaks[0];
    for (const p of peaks) {
      if (p.val >= threshold) { chosen = p; break; }
    }

    // Parabolic interpolation around the chosen lag.
    const t = chosen.idx;
    let refined = t;
    if (t > minTau && t < maxTau) {
      const a = nsdf[t - 1], b = nsdf[t], c = nsdf[t + 1];
      const denom = a - 2 * b + c;
      if (Math.abs(denom) > 1e-12) refined = t + (0.5 * (a - c)) / denom;
    }

    return { freq: this.sampleRate / refined, clarity: chosen.val, rms };
  }
}

/** Convert a frequency to a fractional MIDI note number for a given A4 reference. */
export function freqToMidi(freq, a4 = 440) {
  return 69 + 12 * Math.log2(freq / a4);
}

/** Convert a MIDI note number back to a frequency. */
export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}
