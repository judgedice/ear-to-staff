/** Music theory helpers: note names, key signatures, key detection. */

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * All key signatures VexFlow understands, with MusicXML fifths/mode.
 * Order here is the order shown in the Key dropdown.
 */
export const KEYS = [
  { name: 'C', fifths: 0, mode: 'major' },
  { name: 'G', fifths: 1, mode: 'major' },
  { name: 'D', fifths: 2, mode: 'major' },
  { name: 'A', fifths: 3, mode: 'major' },
  { name: 'E', fifths: 4, mode: 'major' },
  { name: 'B', fifths: 5, mode: 'major' },
  { name: 'F#', fifths: 6, mode: 'major' },
  { name: 'F', fifths: -1, mode: 'major' },
  { name: 'Bb', fifths: -2, mode: 'major' },
  { name: 'Eb', fifths: -3, mode: 'major' },
  { name: 'Ab', fifths: -4, mode: 'major' },
  { name: 'Db', fifths: -5, mode: 'major' },
  { name: 'Gb', fifths: -6, mode: 'major' },
  { name: 'Am', fifths: 0, mode: 'minor' },
  { name: 'Em', fifths: 1, mode: 'minor' },
  { name: 'Bm', fifths: 2, mode: 'minor' },
  { name: 'F#m', fifths: 3, mode: 'minor' },
  { name: 'C#m', fifths: 4, mode: 'minor' },
  { name: 'G#m', fifths: 5, mode: 'minor' },
  { name: 'Dm', fifths: -1, mode: 'minor' },
  { name: 'Gm', fifths: -2, mode: 'minor' },
  { name: 'Cm', fifths: -3, mode: 'minor' },
  { name: 'Fm', fifths: -4, mode: 'minor' },
  { name: 'Bbm', fifths: -5, mode: 'minor' },
  { name: 'Ebm', fifths: -6, mode: 'minor' },
];

/**
 * Transposing instruments. `semis` is how far the written part sits ABOVE
 * concert pitch (E-flat alto sax: a major sixth, 9 semitones). `diatonic` is
 * the same interval in scale steps, for MusicXML's <transpose>. `written` is
 * the comfortable written range in MIDI, used only for warnings.
 */
export const INSTRUMENTS = [
  { id: 'concert', label: 'Concert pitch (as it sounds)', semis: 0, diatonic: 0, clef: null, written: null },
  { id: 'alto', label: 'E♭ alto sax', semis: 9, diatonic: 5, clef: 'treble', written: [58, 90] },
  { id: 'bari', label: 'E♭ baritone sax', semis: 21, diatonic: 12, clef: 'treble', written: [58, 90] },
  { id: 'tenor', label: 'B♭ tenor sax', semis: 14, diatonic: 8, clef: 'treble', written: [58, 90] },
  { id: 'soprano', label: 'B♭ soprano sax', semis: 2, diatonic: 1, clef: 'treble', written: [58, 90] },
  { id: 'trumpet', label: 'B♭ trumpet / clarinet', semis: 2, diatonic: 1, clef: 'treble', written: [52, 94] },
  { id: 'horn', label: 'F horn', semis: 7, diatonic: 4, clef: 'treble', written: [53, 89] },
];

export function instrumentById(id) {
  return INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0];
}

/** The key signature a part written `semis` above concert pitch needs. */
export function transposeKey(key, semis) {
  const n = ((semis % 12) + 12) % 12;
  if (n === 0) return key;
  const table = key.mode === 'minor' ? MINOR_BY_PC : MAJOR_BY_PC;
  const pc = table.indexOf(key.name);
  if (pc < 0) return key;
  return keyByName(table[(pc + n) % 12]);
}

export function keyByName(name) {
  return KEYS.find((k) => k.name === name) ?? KEYS[0];
}

/** Pitch class (0..11) of a MIDI note. */
export function pitchClass(midi) {
  return ((midi % 12) + 12) % 12;
}

/** Scientific octave number (MIDI 60 = C4). */
export function octaveOf(midi) {
  return Math.floor(midi / 12) - 1;
}

/** "C#" / "Db" etc. depending on the key's accidental preference. */
export function noteName(midi, key) {
  const useFlats = key && key.fifths < 0;
  const names = useFlats ? FLAT_NAMES : SHARP_NAMES;
  return names[pitchClass(midi)];
}

/** Human-readable name with octave, e.g. "F#4". */
export function fullName(midi, key) {
  return `${noteName(midi, key)}${octaveOf(midi)}`;
}

/** VexFlow key string, e.g. "c#/4". */
export function vexKey(midi, key) {
  const n = noteName(midi, key);
  const letter = n[0].toLowerCase();
  const acc = n.slice(1); // "", "#", or "b"
  return `${letter}${acc}/${octaveOf(midi)}`;
}

/** MusicXML pitch parts: { step, alter, octave }. */
export function xmlPitch(midi, key) {
  const n = noteName(midi, key);
  const step = n[0];
  const alter = n.includes('#') ? 1 : n.includes('b') ? -1 : 0;
  return { step, alter, octave: octaveOf(midi) };
}

// Krumhansl-Schmuckler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_BY_PC = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_BY_PC = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

/**
 * Guess the key from a list of notes ({ midi, start, end }) by correlating a
 * duration-weighted pitch-class histogram against the Krumhansl profiles.
 * Returns a KEYS entry. Falls back to C major with too little material.
 */
export function detectKey(notes) {
  if (!notes || notes.length < 3) return keyByName('C');
  const hist = new Array(12).fill(0);
  for (const n of notes) {
    const dur = Math.max(0.05, (n.end ?? n.start + 0.25) - n.start);
    hist[pitchClass(n.midi)] += dur;
  }
  let best = { score: -Infinity, name: 'C' };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = hist.map((_, i) => hist[(i + tonic) % 12]);
    const sMaj = pearson(rotated, MAJOR_PROFILE);
    const sMin = pearson(rotated, MINOR_PROFILE);
    if (sMaj > best.score) best = { score: sMaj, name: MAJOR_BY_PC[tonic] };
    if (sMin > best.score) best = { score: sMin, name: MINOR_BY_PC[tonic] };
  }
  return keyByName(best.name);
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return -1;
  return num / Math.sqrt(da * db);
}
