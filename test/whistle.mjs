import { FFT } from '../js/fft.js';
import { WhistleTracker } from '../js/whistle.js';
import { NoteSegmenter } from '../js/segmenter.js';
import { ticksToSeconds, secondsToTicks, quantize, parseTimeSig } from '../js/notation.js';
import { fullName } from '../js/theory.js';

let fails = 0;
// Deterministic noise so the end-to-end checks cannot flake between runs.
let seed = 0x9e3779b9;
function rand() { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function check(cond, msg) { if (!cond) { fails++; console.log('FAIL', msg); } else console.log('ok  ', msg); }

// 1. FFT vs naive DFT
{
  const n = 64, fft = new FFT(n);
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.3) + 0.5 * Math.cos(i * 1.7);
  const r2 = Float32Array.from(re), i2 = new Float32Array(n);
  fft.transform(r2, i2);
  let maxErr = 0;
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) { const a = (-2 * Math.PI * k * t) / n; sr += re[t] * Math.cos(a); si += re[t] * Math.sin(a); }
    maxErr = Math.max(maxErr, Math.abs(sr - r2[k]), Math.abs(si - i2[k]));
  }
  check(maxErr < 1e-3, `FFT matches DFT (max err ${maxErr.toExponential(2)})`);
}

// 2. Whistle tracker picks the whistle out of a mix
const sr = 44100;
/**
 * Synthetic record: acoustic guitar chord (partials rolling off as 1/h^2),
 * optional vocal line (partials 1/sqrt(h), strong up to 3 kHz), optional
 * whistle with +/-40-cent vibrato at 5.5 Hz.
 */
function mix(whistleHz, t0, { n = 2048, whistleAmp = 0.1, vocal = false } = {}) {
  const buf = new Float32Array(n);
  let phase = 0; // accumulate phase so vibrato is true frequency modulation
  for (let i = 0; i < n; i++) {
    const t = t0 + i / sr;
    let v = 0;
    for (const f of [110, 138.6, 164.8, 220]) for (let h = 1; h <= 10; h++) v += (0.3 / (h * h)) * Math.sin(2 * Math.PI * f * h * t + h);
    if (vocal) for (let h = 1; h <= 15; h++) v += (0.2 / Math.sqrt(h)) * Math.sin(2 * Math.PI * 196 * h * t + 0.5 * h);
    if (whistleHz) {
      const vib = Math.pow(2, (40 / 1200) * Math.sin(2 * Math.PI * 5.5 * t));
      phase += (2 * Math.PI * whistleHz * vib) / sr;
      v += whistleAmp * Math.sin(phase);
    }
    v += (rand() - 0.5) * 0.01;
    buf[i] = v;
  }
  return buf;
}
{
  const tr = new WhistleTracker(sr, 2048, { minFreq: 850, maxFreq: 4300 });
  const results = [];
  for (const [hz, label] of [[1480, 'F#6'], [1760, 'A6'], [1975.5, 'B6'], [1174.7, 'D6'], [2637, 'E7']]) {
    const r = tr.detect(mix(hz, 0.123));
    const cents = 1200 * Math.log2(r.freq / hz);
    results.push(`${label}: ${r.freq.toFixed(0)}Hz (${cents.toFixed(0)}c, ${r.clarity.toFixed(2)})`);
    check(Math.abs(cents) < 45 && r.clarity >= 0.6, `whistle ${label} over guitar`);
  }
  console.log('   ', results.join(' | '));

  // Whistle while someone is singing underneath (hard case): whistle 8 dB above the vocal partials in band.
  const tr3 = new WhistleTracker(sr, 2048, { minFreq: 850, maxFreq: 4300 });
  const hard = tr3.detect(mix(1760, 0.3, { vocal: true, whistleAmp: 0.2 }));
  const hc = 1200 * Math.log2(hard.freq / 1760);
  check(Math.abs(hc) < 60 && hard.clarity >= 0.6, `whistle A6 over guitar + vocal -> ${hard.freq.toFixed(0)}Hz (${hc.toFixed(0)}c, ${hard.clarity.toFixed(2)})`);

  // No whistle: singing + guitar only. Vocal overtones in band must be rejected.
  let falsePos = 0, maxC = 0;
  const tr2 = new WhistleTracker(sr, 2048, { minFreq: 850, maxFreq: 4300 });
  for (let k = 0; k < 20; k++) { const r = tr2.detect(mix(0, k * 0.05, { vocal: true })); maxC = Math.max(maxC, r.clarity); if (r.clarity >= 0.6) falsePos++; }
  check(falsePos <= 1, `false positives on 20 vocal+guitar frames: ${falsePos} (max clarity ${maxC.toFixed(2)})`);
  let fp2 = 0;
  for (let k = 0; k < 20; k++) { const r = tr2.detect(mix(0, k * 0.05)); if (r.clarity >= 0.6) fp2++; }
  console.log(`    (raw tracker on quiet guitar-only frames: ${fp2}/20 pass clarity 0.6; the level prior below handles these)`);
}

// 2b. Whole pipeline on a synthetic record: guitar intro, whistled melody, sung line.
{
  const dur = 7, len = sr * dur;
  const data = new Float32Array(len);
  const bpm = 100, beat = 60 / bpm;
  const melody = [[81, 0, 1], [83, 1, 1], [85, 2, 0.5], [86, 2.5, 0.5], [88, 3, 1.5], [86, 4.5, 0.5], [85, 5, 1]]; // midi, beat, beats
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let v = 0;
    for (const f of [110, 138.6, 164.8, 220]) for (let h = 1; h <= 10; h++) v += (0.3 / (h * h)) * Math.sin(2 * Math.PI * f * h * t + h);
    if (t > 5.3) for (let h = 1; h <= 15; h++) v += (0.2 / Math.sqrt(h)) * Math.sin(2 * Math.PI * 196 * h * t + 0.5 * h); // singing after the whistle
    for (const [m, b, l] of melody) {
      const st = 1.0 + b * beat, en = st + l * beat - 0.06;
      if (t >= st && t < en) {
        const f = 440 * Math.pow(2, (m - 69) / 12);
        const vib = Math.pow(2, (40 / 1200) * Math.sin(2 * Math.PI * 5.5 * t));
        phase += (2 * Math.PI * f * vib) / sr;
        const env = Math.min(1, (t - st) / 0.03, (en - t) / 0.05);
        v += 0.12 * env * Math.sin(phase);
      }
    }
    v += (rand() - 0.5) * 0.01;
    data[i] = v * 0.6;
  }
  const fakeBuffer = { sampleRate: sr, length: len, duration: dur, numberOfChannels: 1, getChannelData: () => data };
  const { analyzeBuffer } = await import('../js/analysis.js');
  const res = await analyzeBuffer(fakeBuffer, { method: 'whistle', lowMidi: 81, highMidi: 108, a4: 440, clarity: 0.6, gateRms: Math.pow(10, -45 / 20), changeCents: 80 });
  const got = res.notes.map((n) => `${fullName(n.midi)}@${n.start.toFixed(2)}`);
  console.log('    pipeline notes:', got.join(' '));
  const want = melody.map(([m]) => m);
  const gotMidi = res.notes.map((n) => n.midi);
  check(gotMidi.join(',') === want.join(','), `pipeline finds exactly the whistled melody (${gotMidi.map(fullName).join(' ')})`);
  const onsetErr = res.notes.length === melody.length ? Math.max(...res.notes.map((n, i) => Math.abs(n.start - (1.0 + melody[i][1] * beat)))) : 9;
  check(onsetErr < 0.06, `onsets within 60 ms (max ${(onsetErr * 1000).toFixed(0)} ms)`);
  const inIntroOrVocal = res.notes.filter((n) => n.start < 0.95 || n.start > 5.3).length;
  check(inIntroOrVocal === 0, `no notes during guitar intro or sung section (${inIntroOrVocal})`);
}

// 3. Segmenter hysteresis: vibrato ±45 cents around a boundary stays one note
{
  const seg = new NoteSegmenter({ changeCents: 80, gateRms: 0.001 });
  const hop = 0.01;
  const out = [];
  for (let i = 0; i < 100; i++) {
    const t = i * hop;
    const midi = 81.5 + 0.45 * Math.sin(2 * Math.PI * 5.5 * t); // wobbles across A5/A#5 boundary
    out.push(...seg.push({ t, midi, clarity: 0.9, rms: 0.1 }));
  }
  out.push(...seg.flush(1.0));
  check(out.length === 1, `vibrato across semitone boundary -> ${out.length} note(s)`);
  const seg2 = new NoteSegmenter({ changeCents: 30, gateRms: 0.001 });
  const out2 = [];
  for (let i = 0; i < 100; i++) { const t = i * hop; out2.push(...seg2.push({ t, midi: 81.5 + 0.45 * Math.sin(2 * Math.PI * 5.5 * t), clarity: 0.9, rms: 0.1 })); }
  out2.push(...seg2.flush(1.0));
  check(out2.length > 1, `same wobble with 30-cent tolerance fragments (${out2.length} notes), so the slider matters`);
  // A real step of 2 semitones still splits
  const seg3 = new NoteSegmenter({ changeCents: 80, gateRms: 0.001 });
  const out3 = [];
  for (let i = 0; i < 100; i++) { const t = i * hop; out3.push(...seg3.push({ t, midi: i < 50 ? 81 : 83, clarity: 0.9, rms: 0.1 })); }
  out3.push(...seg3.flush(1.0));
  check(out3.length === 2 && out3[0].midi === 81 && out3[1].midi === 83, `step of a whole tone -> ${out3.map(n => fullName(n.midi)).join(',')}`);
}

// 4. Swing mapping round-trips and places the off-beat late
{
  const o = { bpm: 120, timeSig: parseTimeSig('4/4'), swing: 2 / 3 };
  let maxErr = 0;
  for (let tick = 0; tick <= 64; tick += 0.5) maxErr = Math.max(maxErr, Math.abs(secondsToTicks(ticksToSeconds(tick, o), o) - tick));
  check(maxErr < 1e-9, `swing tick<->seconds round trip (err ${maxErr.toExponential(1)})`);
  check(Math.abs(ticksToSeconds(2, o) - (0.5 * 2) / 3) < 1e-9, 'swung off-beat eighth lands at 2/3 of the beat');
  // Swung eighths played at 0, 0.333, 0.5, 0.833 s quantize to straight eighth notation
  const notes = [0, 1 / 3, 0.5, 5 / 6].map((t, i) => ({ start: t, end: t + 0.15, midi: 60 + i }));
  const m = quantize(notes, { ...o, grid: 8, t0: 0 });
  const onsets = []; let tk = 0;
  for (const el of m[0]) { if (el.type === 'note') onsets.push(tk); tk += el.ticks; }
  check(onsets.join(',') === '0,2,4,6', `swung performance -> straight eighths at ticks ${onsets.join(',')}`);
  // Bar offset: t0 negative shifts notes later
  const m2 = quantize([{ start: 0, end: 0.5, midi: 60 }], { ...o, grid: 16, t0: -1.5 });
  const first = m2[0].findIndex((e) => e.type === 'note');
  const restTicks = m2[0].slice(0, first).reduce((a, e) => a + e.ticks, 0);
  check(restTicks === 12, `offset of 3 beats puts the first note on beat 4 (rest ${restTicks} ticks)`);
}

console.log(fails ? `\n${fails} FAILURES` : '\nall passed');
process.exit(fails ? 1 : 0);
