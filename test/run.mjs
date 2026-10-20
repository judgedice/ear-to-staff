import { PitchDetector, freqToMidi } from '../js/pitch.js';
import { NoteSegmenter } from '../js/segmenter.js';
import { quantize, parseTimeSig, durationInfo } from '../js/notation.js';
import { detectKey, keyByName, vexKey, fullName, transposeKey, instrumentById } from '../js/theory.js';
import { toMusicXML } from '../js/musicxml.js';

const sr = 48000;
const det = new PitchDetector(sr);
let fails = 0;
function check(cond, msg) { if (!cond) { fails++; console.log('FAIL', msg); } else console.log('ok  ', msg); }

// 1. Pitch detection on synthetic tones (with harmonics + noise)
for (const f of [82.4, 110, 196, 261.6, 440, 659.3, 1046.5]) {
  const buf = new Float32Array(2048);
  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    buf[i] = 0.5 * Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * 2 * f * t + 0.3)
      + 0.12 * Math.sin(2 * Math.PI * 3 * f * t + 1.1) + (Math.random() - 0.5) * 0.02;
  }
  const r = det.detect(buf);
  const cents = 1200 * Math.log2(r.freq / f);
  check(Math.abs(cents) < 5 && r.clarity > 0.85, `pitch ${f}Hz -> ${r.freq.toFixed(2)}Hz (${cents.toFixed(1)}c, clarity ${r.clarity.toFixed(2)})`);
}
// noise should be low clarity
{
  const buf = new Float32Array(2048).map(() => (Math.random() - 0.5) * 0.2);
  const r = det.detect(buf);
  check(r.clarity < 0.6, `noise clarity ${r.clarity.toFixed(2)}`);
}
// timing
{
  const buf = new Float32Array(2048).map((_, i) => Math.sin(i * 0.05));
  const t = performance.now();
  for (let k = 0; k < 50; k++) det.detect(buf);
  const ms = (performance.now() - t) / 50;
  check(ms < 8, `detect() avg ${ms.toFixed(2)} ms/frame`);
}

// 2. Segmenter: C4 for 0.5s, D4 for 0.5s, silence 0.2s, E4 twice with a level dip
const seg = new NoteSegmenter({ gateRms: 0.005 });
const hop = 0.016;
let t = 0;
const frames = [];
const add = (dur, midi, rms = 0.1, clarity = 0.95) => { for (let k = 0; k < Math.round(dur / hop); k++) { frames.push({ t, midi, clarity, rms }); t += hop; } };
add(0.5, 60.05); add(0.5, 62.1); add(0.2, NaN, 0.0001, 0); add(0.4, 64, 0.2); add(0.05, 64, 0.02); add(0.4, 64, 0.2); add(0.3, NaN, 0, 0);
const notes = [];
for (const fr of frames) notes.push(...seg.push(fr));
notes.push(...seg.flush(t));
console.log(notes.map(n => `${fullName(n.midi)} ${n.start.toFixed(2)}-${n.end.toFixed(2)}`).join(' | '));
check(notes.length === 4, `segmenter produced ${notes.length} notes (expect 4)`);
check(notes[0]?.midi === 60 && notes[1]?.midi === 62 && notes[2]?.midi === 64 && notes[3]?.midi === 64, 'segmenter pitches C4 D4 E4 E4');
check(notes[0] && notes[0].start < 0.02, `first onset at ${notes[0]?.start.toFixed(3)}`);

// 3. Quantize: 90 bpm, quarter = 0.6667s
const bpm = 90, q = 60 / bpm;
const raw = [
  { start: 0, end: q, midi: 60 },              // quarter
  { start: q, end: q * 1.5, midi: 62 },        // eighth
  { start: q * 1.5, end: q * 2, midi: 64 },    // eighth
  { start: q * 2, end: q * 3.5, midi: 65 },    // dotted quarter
  { start: q * 3.5, end: q * 6, midi: 67 },    // eighth tied across bar into a half
];
const measures = quantize(raw, { bpm, grid: 16, timeSig: parseTimeSig('4/4'), t0: 0 });
const show = (m) => m.map(e => `${e.type === 'rest' ? 'r' : fullName(e.midi)}:${e.ticks}${e.tieStart ? '~' : ''}${e.tieEnd ? '_' : ''}`).join(' ');
measures.forEach((m, i) => console.log(`bar ${i + 1}: ${show(m)}`));
check(measures.length === 2, 'two bars');
check(show(measures[0]) === 'C4:4 D4:2 E4:2 F4:6 G4:2~', 'bar 1 durations');
check(show(measures[1]) === 'G4:8_ r:8', 'bar 2 tied half + half rest');
for (const m of measures) check(m.reduce((a, e) => a + e.ticks, 0) === 16, 'bar sums to 16 ticks');
for (const m of measures) for (const e of m) check(!!durationInfo(e.ticks), `duration ${e.ticks} notatable`);

// Off-beat quarter should split across mid-bar
const m2 = quantize([{ start: q * 1.75, end: q * 2.75, midi: 60 }], { bpm, grid: 16, timeSig: parseTimeSig('4/4'), t0: 0 });
console.log('offbeat:', show(m2[0]));
check(m2[0].filter(e => e.type === 'note').length === 2 && m2[0].filter(e => e.type === 'note').every(e => e.ticks === 1 || e.ticks === 3), 'off-beat quarter split at mid-bar');

// 3/4 and 6/8 fill
const m3 = quantize([{ start: 0, end: q * 3, midi: 60 }], { bpm, grid: 8, timeSig: parseTimeSig('3/4'), t0: 0 });
check(m3.length === 1 && m3[0].length === 1 && m3[0][0].ticks === 12, `3/4 dotted half: ${show(m3[0])}`);
const m4 = quantize([], { bpm, grid: 16, timeSig: parseTimeSig('6/8'), t0: 0 });
check(m4.length === 1 && m4[0].reduce((a, e) => a + e.ticks, 0) === 12, `6/8 empty bar: ${show(m4[0])}`);

// 4. Key detection: G major scale
const gmaj = [67, 69, 71, 72, 74, 76, 78, 79].map((m, i) => ({ start: i * 0.5, end: i * 0.5 + 0.5, midi: m }));
gmaj.push({ start: 4, end: 6, midi: 67 });
const k = detectKey(gmaj);
check(k.name === 'G' || k.name === 'Em', `key detect G major scale -> ${k.name}`);
check(vexKey(70, keyByName('F')) === 'bb/4' && vexKey(70, keyByName('C')) === 'a#/4', 'spelling by key');

// 5. MusicXML well-formed-ish
const xml = toMusicXML(measures, { key: keyByName('C'), clef: 'treble', timeSig: parseTimeSig('4/4'), bpm });
check(xml.includes('<tie type="start"/>') && xml.includes('<tied type="stop"/>') && (xml.match(/<measure /g) || []).length === 2, 'musicxml ties + measures');
// 6. Transposing instruments
const alto = instrumentById('alto'), tenor = instrumentById('tenor'), bari = instrumentById('bari');
check(transposeKey(keyByName('C'), alto.semis).name === 'A', 'C concert -> A for alto sax');
check(transposeKey(keyByName('Eb'), alto.semis).name === 'C', 'Eb concert -> C for alto sax');
check(transposeKey(keyByName('G'), tenor.semis).name === 'A', 'G concert -> A for tenor sax');
check(transposeKey(keyByName('Am'), bari.semis).name === 'F#m', 'A minor concert -> F# minor for bari sax');
check(transposeKey(keyByName('F'), 0) === keyByName('F'), 'no transposition keeps the key');
check(transposeKey(keyByName('Bb'), instrumentById('horn').semis).name === 'F', 'Bb concert -> F for horn');
{
  const o = { key: keyByName('A'), clef: 'treble', timeSig: parseTimeSig('4/4'), bpm, instrument: alto, octaveShift: 0 };
  const x = toMusicXML(measures, o);
  check(x.includes('<transpose><diatonic>-5</diatonic><chromatic>-9</chromatic></transpose>'), 'alto sax <transpose> -5/-9');
  check(x.includes('<part-name>E♭ alto sax</part-name>'), 'part named after the instrument');
  const xb = toMusicXML(measures, { ...o, instrument: bari });
  check(xb.includes('<transpose><diatonic>-5</diatonic><chromatic>-9</chromatic><octave-change>-1</octave-change></transpose>'), 'bari sax adds octave-change -1');
  const xt = toMusicXML(measures, { ...o, instrument: tenor, octaveShift: 1 });
  check(xt.includes('<diatonic>-1</diatonic><chromatic>-2</chromatic><octave-change>-2</octave-change>'), 'tenor + octave up: -1/-2, octave-change -2');
  const xc = toMusicXML(measures, { ...o, instrument: instrumentById('concert'), octaveShift: 0 });
  check(!xc.includes('<transpose>') && xc.includes('<part-name>Melody</part-name>'), 'concert pitch has no <transpose>');
}

console.log(fails ? `\n${fails} FAILURES` : '\nall passed');
process.exit(fails ? 1 : 0);
