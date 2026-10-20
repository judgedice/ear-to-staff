/**
 * Turns a stream of pitch frames into discrete notes.
 *
 * Each frame is { t, midi, clarity, rms } where midi is a fractional MIDI value
 * (or NaN when nothing was detected). The segmenter confirms an onset after a few
 * stable frames, ends a note after a few silent frames, splits when the pitch moves
 * to a different semitone, and re-triggers a repeated note when the level jumps.
 */
export class NoteSegmenter {
  constructor(opts = {}) {
    this.onsetFrames = opts.onsetFrames ?? 3;     // frames of a stable pitch before a note starts
    this.offsetFrames = opts.offsetFrames ?? 5;   // frames of silence before a note ends
    this.changeFrames = opts.changeFrames ?? 3;   // frames on a new pitch before we split
    this.minNoteMs = opts.minNoteMs ?? 70;        // shorter notes are discarded
    this.clarityThreshold = opts.clarityThreshold ?? 0.85;
    this.gateRms = opts.gateRms ?? 0.005;         // linear RMS noise gate
    this.retriggerRatio = opts.retriggerRatio ?? 3.0;
    this.changeCents = opts.changeCents ?? 60;    // deviation from the note's centre that counts as a new note

    this.current = null;    // in-progress note
    this.candidate = null;  // pitch we are waiting to confirm
    this.silence = 0;
    this.lastVoicedT = 0;
    this.recentRms = [];
    this.notes = [];
  }

  /** Current, not-yet-finished note (for live display), or null. */
  get live() {
    if (!this.current) return null;
    return {
      start: this.current.start,
      midi: Math.round(median(this.current.samples)),
    };
  }

  reset() {
    this.current = null;
    this.candidate = null;
    this.silence = 0;
    this.recentRms = [];
    this.notes = [];
  }

  /**
   * Feed one analysis frame. Returns an array of finalized notes produced by this frame
   * (usually empty or one note).
   */
  push(frame) {
    const out = [];
    const voiced = Number.isFinite(frame.midi) &&
      frame.clarity >= this.clarityThreshold &&
      frame.rms >= this.gateRms;

    const rounded = voiced ? Math.round(frame.midi) : null;

    if (this.current) {
      if (!voiced) {
        this.silence++;
        if (this.silence >= this.offsetFrames) {
          const n = this._finish(this.lastVoicedT);
          if (n) out.push(n);
          this.candidate = null;
        }
        return out;
      }

      this.silence = 0;
      this.lastVoicedT = frame.t;
      const centre = median(this.current.samples);
      const tol = this.changeCents / 100;

      if (Math.abs(frame.midi - centre) >= tol) {
        // Pitch moved beyond vibrato range. Wait for a few frames before believing it.
        if (this.candidate && Math.abs(frame.midi - mean(this.candidate.samples)) < tol) {
          this.candidate.count++;
          this.candidate.samples.push(frame.midi);
        } else {
          this.candidate = { start: frame.t, midi: rounded, count: 1, samples: [frame.midi] };
        }
        if (this.candidate.count >= this.changeFrames) {
          const n = this._finish(this.candidate.start);
          if (n) out.push(n);
          this._begin(this.candidate.start, this.candidate.samples, frame.rms);
          this.candidate = null;
        }
        return out;
      }

      // Same pitch: check for a re-articulation (level dips, then jumps back up).
      this.candidate = null;
      const durMs = (frame.t - this.current.start) * 1000;
      const recentMin = this.recentRms.length ? Math.min(...this.recentRms) : frame.rms;
      if (durMs > this.minNoteMs &&
          frame.rms > recentMin * this.retriggerRatio &&
          frame.rms > this.gateRms * 2) {
        const n = this._finish(frame.t);
        if (n) out.push(n);
        this._begin(frame.t, [frame.midi], frame.rms);
      } else {
        this.current.samples.push(frame.midi);
      }
      this._trackRms(frame.rms);
      return out;
    }

    // No current note. Look for an onset.
    if (!voiced) {
      this.candidate = null;
      return out;
    }
    if (this.candidate && Math.abs(frame.midi - mean(this.candidate.samples)) < this.changeCents / 100) {
      this.candidate.count++;
      this.candidate.samples.push(frame.midi);
    } else {
      this.candidate = { start: frame.t, midi: rounded, count: 1, samples: [frame.midi] };
    }
    if (this.candidate.count >= this.onsetFrames) {
      this._begin(this.candidate.start, this.candidate.samples, frame.rms);
      this.lastVoicedT = frame.t;
      this.candidate = null;
    }
    return out;
  }

  /** Close any in-progress note (e.g. when the user stops listening). */
  flush(t) {
    const out = [];
    if (this.current) {
      const n = this._finish(t ?? this.lastVoicedT);
      if (n) out.push(n);
    }
    this.candidate = null;
    return out;
  }

  _begin(start, samples, rms) {
    this.current = { start, samples: samples.slice() };
    this.recentRms = [rms];
    this.silence = 0;
  }

  _finish(end) {
    const cur = this.current;
    this.current = null;
    this.recentRms = [];
    if (!cur) return null;
    const durMs = (end - cur.start) * 1000;
    if (durMs < this.minNoteMs) return null;
    const med = median(cur.samples);
    const note = {
      start: cur.start,
      end,
      midi: Math.round(med),
      cents: Math.round((med - Math.round(med)) * 100),
    };
    this.notes.push(note);
    return note;
  }

  _trackRms(rms) {
    this.recentRms.push(rms);
    if (this.recentRms.length > 8) this.recentRms.shift();
  }
}

export function median(arr) {
  if (arr.length === 0) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(arr) {
  let t = 0;
  for (const v of arr) t += v;
  return arr.length ? t / arr.length : NaN;
}
