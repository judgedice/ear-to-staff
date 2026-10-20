/**
 * Offline analysis of a decoded AudioBuffer in two stages:
 *   detectFrames(buffer, opts)  -> per-frame trace { t, midi, clarity, rms }
 *   segmentTrace(trace, opts)   -> notes
 * Detection is the slow part; segmentation is instant, so the UI can re-segment
 * when the clarity, noise gate, or vibrato settings change.
 */
import { PitchDetector, freqToMidi, midiToFreq } from './pitch.js';
import { WhistleTracker } from './whistle.js';
import { NoteSegmenter } from './segmenter.js';

/** Build a detector for the given method and range. Returns { detector, frameSize, hopSec }. */
export function makeDetector(method, sampleRate, lowMidi, highMidi, a4) {
  const minFreq = midiToFreq(lowMidi - 1, a4);
  const maxFreq = midiToFreq(highMidi + 1, a4);
  if (method === 'whistle') {
    const frameSize = 2048; // short window: vibrato smears less, and ~20 Hz bins are plenty above 800 Hz
    return { detector: new WhistleTracker(sampleRate, frameSize, { minFreq, maxFreq }), frameSize, hopSec: 0.01 };
  }
  const frameSize = minFreq < 50 ? 4096 : 2048;
  return { detector: new PitchDetector(sampleRate, { minFreq, maxFreq }), frameSize, hopSec: 0.016 };
}

/** Segmenter frame counts derived from the hop so behaviour is hop-independent. */
export function segmenterOptions(hopSec, s) {
  return {
    onsetFrames: Math.max(2, Math.round(0.045 / hopSec)),
    offsetFrames: Math.max(2, Math.round(0.08 / hopSec)),
    changeFrames: Math.max(2, Math.round(0.05 / hopSec)),
    minNoteMs: s.minNoteMs ?? 70,
    clarityThreshold: s.clarity,
    gateRms: s.gateRms,
    changeCents: s.changeCents,
  };
}

/**
 * Run the detector over the recording.
 * @returns {Promise<{trace:Array, from:number, to:number, hopSec:number}|null>} null if cancelled
 */
export async function detectFrames(audioBuffer, o, onProgress, isCancelled) {
  const sr = audioBuffer.sampleRate;
  const mono = toMono(audioBuffer);
  const from = Math.max(0, o.from ?? 0);
  const to = Math.min(audioBuffer.duration, o.to ?? audioBuffer.duration);
  const { detector, frameSize, hopSec } = makeDetector(o.method, sr, o.lowMidi, o.highMidi, o.a4);
  const hop = Math.round(hopSec * sr);
  const startSample = Math.floor(from * sr);
  const endSample = Math.floor(to * sr);
  const frame = new Float32Array(frameSize);
  const trace = [];
  const totalFrames = Math.max(1, Math.floor((endSample - startSample - frameSize) / hop));

  for (let i = 0; i < totalFrames; i++) {
    const pos = startSample + i * hop;
    frame.set(mono.subarray(pos, pos + frameSize));
    const t = (pos + frameSize / 2) / sr;
    const { freq, clarity, rms } = detector.detect(frame);
    let midi = Number.isFinite(freq) ? freqToMidi(freq, o.a4) : NaN;
    if (Number.isFinite(midi)) {
      const r = Math.round(midi);
      if (r < o.lowMidi || r > o.highMidi) midi = NaN;
    }
    trace.push({ t, midi, clarity, rms });
    if (i % 200 === 199) {
      if (isCancelled && isCancelled()) return null;
      if (onProgress) onProgress(i / totalFrames);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress(1);
  return { trace, from, to, hopSec };
}

/**
 * Level prior: frames far quieter than the loudest pitched material in the
 * recording are unlikely to be the featured line. Returns the clarity each
 * frame effectively has after that prior (used for both segmentation and display).
 */
export function effectiveClarity(trace) {
  const voiced = trace.filter((f) => Number.isFinite(f.midi) && f.clarity > 0.3 && f.rms > 0);
  if (voiced.length < 5) return trace.map((f) => f.clarity);
  const levels = voiced.map((f) => 20 * Math.log10(f.rms)).sort((a, b) => a - b);
  const refDb = levels[Math.floor(levels.length * 0.9)];
  return trace.map((f) => {
    if (!Number.isFinite(f.midi) || f.rms <= 0) return 0;
    const rel = 20 * Math.log10(f.rms) - refDb;
    const factor = Math.min(1, Math.max(0, (rel + 30) / 15));   // full weight down to -15 dB, nothing below -30 dB
    return f.clarity * factor;
  });
}

/** Segment a trace into notes using the current clarity / gate / vibrato settings. */
export function segmentTrace(trace, hopSec, o, to) {
  const seg = new NoteSegmenter(segmenterOptions(hopSec, o));
  const eff = effectiveClarity(trace);
  const notes = [];
  trace.forEach((f, i) => { notes.push(...seg.push({ t: f.t, midi: f.midi, clarity: eff[i], rms: f.rms })); });
  notes.push(...seg.flush(to ?? (trace.length ? trace[trace.length - 1].t : 0)));
  return notes;
}

/** Convenience: detect + segment in one call. */
export async function analyzeBuffer(audioBuffer, o, onProgress, isCancelled) {
  const d = await detectFrames(audioBuffer, o, onProgress, isCancelled);
  if (!d) return null;
  return { ...d, notes: segmentTrace(d.trace, d.hopSec, o, d.to) };
}

export function toMono(audioBuffer) {
  const n = audioBuffer.length;
  const ch = audioBuffer.numberOfChannels;
  if (ch === 1) return audioBuffer.getChannelData(0);
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = audioBuffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}
