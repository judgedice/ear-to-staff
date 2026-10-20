/**
 * Quantization to a rhythmic grid, measure splitting, and VexFlow rendering.
 *
 * Internally every duration is in "ticks" where 1 tick = one sixteenth note.
 */
import { vexKey } from './theory.js';

export const TICKS_PER_QUARTER = 4;

const DURATIONS = [
  { ticks: 16, vex: 'w', xml: 'whole', dots: 0, align: 16 },
  { ticks: 12, vex: 'h', xml: 'half', dots: 1, align: 4 },
  { ticks: 8, vex: 'h', xml: 'half', dots: 0, align: 4 },
  { ticks: 6, vex: 'q', xml: 'quarter', dots: 1, align: 2 },
  { ticks: 4, vex: 'q', xml: 'quarter', dots: 0, align: 2 },
  { ticks: 3, vex: '8', xml: 'eighth', dots: 1, align: 1 },
  { ticks: 2, vex: '8', xml: 'eighth', dots: 0, align: 1 },
  { ticks: 1, vex: '16', xml: '16th', dots: 0, align: 1 },
];

export function parseTimeSig(str) {
  const [beats, beatValue] = str.split('/').map(Number);
  return { beats, beatValue, ticks: beats * (16 / beatValue) };
}

/**
 * Quantize raw notes onto the grid and split them into measures.
 *
 * @param {Array<{start:number,end:number,midi:number}>} notes  seconds, absolute
 * @param {object} o
 * @param {number} o.bpm
 * @param {number} o.grid       8 or 16 (smallest note value)
 * @param {{beats:number,beatValue:number,ticks:number}} o.timeSig
 * @param {number} o.t0         time of bar 1 beat 1, in the same clock as notes
 * @returns {Array<Array<Element>>} measures; Element = { type:'note'|'rest', ticks, midi?, tieStart?, tieEnd?, live? }
 */
export function quantize(notes, o) {
  const gridTicks = 16 / o.grid;                  // ticks per grid step (1 or 2)

  const q = [];
  for (const n of notes) {
    let on = Math.round(secondsToTicks(n.start - o.t0, o) / gridTicks);
    let off = Math.round(secondsToTicks(n.end - o.t0, o) / gridTicks);
    if (on < 0) on = 0;
    if (off <= on) off = on + 1;
    q.push({ on: on * gridTicks, off: off * gridTicks, midi: n.midi, live: !!n.live });
  }
  q.sort((a, b) => a.on - b.on);

  // Resolve overlaps and collisions.
  const clean = [];
  for (const n of q) {
    const prev = clean[clean.length - 1];
    if (prev) {
      if (n.on <= prev.on) continue;               // same onset: keep the earlier one
      if (n.on < prev.off) prev.off = n.on;        // clip the previous note
    }
    clean.push(n);
  }

  // Build a continuous timeline with rests.
  const timeline = [];
  let cursor = 0;
  for (const n of clean) {
    if (n.on > cursor) timeline.push({ type: 'rest', on: cursor, off: n.on });
    timeline.push({ type: 'note', on: n.on, off: n.off, midi: n.midi, live: n.live });
    cursor = n.off;
  }

  const mTicks = o.timeSig.ticks;
  const total = Math.max(mTicks, Math.ceil(cursor / mTicks) * mTicks);
  if (cursor < total) timeline.push({ type: 'rest', on: cursor, off: total });

  // Split into measures, tying notes across barlines.
  const measureCount = total / mTicks;
  const measures = Array.from({ length: measureCount }, () => []);
  for (const ev of timeline) {
    let pos = ev.on;
    while (pos < ev.off) {
      const mi = Math.floor(pos / mTicks);
      const mStart = mi * mTicks;
      const chunkEnd = Math.min(ev.off, mStart + mTicks);
      const pieces = decompose(pos - mStart, chunkEnd - pos, mTicks, ev.type === 'rest');
      let p = pos;
      for (const len of pieces) {
        const el = { type: ev.type, ticks: len, live: ev.live };
        if (ev.type === 'note') {
          el.midi = ev.midi;
          el.tieEnd = p > ev.on;
          el.tieStart = p + len < ev.off;
        }
        measures[mi].push(el);
        p += len;
      }
      pos = chunkEnd;
    }
  }
  return measures;
}

/**
 * Swing-aware mapping between score ticks and seconds.
 * `o.swing` is the fraction of a beat taken by the first eighth: 0.5 straight,
 * about 0.58 light swing, 2/3 triplet swing. Swing applies to quarter-note beats only.
 */
export function ticksToSeconds(tick, o) {
  const beatTicks = 16 / o.timeSig.beatValue;
  const beatSec = (60 / o.bpm) * (4 / o.timeSig.beatValue);
  const swing = o.timeSig.beatValue === 4 ? (o.swing ?? 0.5) : 0.5;
  const beatIdx = Math.floor(tick / beatTicks);
  const frac = tick / beatTicks - beatIdx;
  const fs = frac < 0.5 ? (frac / 0.5) * swing : swing + ((frac - 0.5) / 0.5) * (1 - swing);
  return (beatIdx + fs) * beatSec;
}

export function secondsToTicks(sec, o) {
  const beatTicks = 16 / o.timeSig.beatValue;
  const beatSec = (60 / o.bpm) * (4 / o.timeSig.beatValue);
  const swing = o.timeSig.beatValue === 4 ? (o.swing ?? 0.5) : 0.5;
  const beats = sec / beatSec;
  const beatIdx = Math.floor(beats);
  const fs = beats - beatIdx;
  const frac = fs < swing ? (fs / swing) * 0.5 : 0.5 + ((fs - swing) / (1 - swing)) * 0.5;
  return (beatIdx + frac) * beatTicks;
}

/** Break a span at `start` (ticks into the measure) of `len` ticks into notatable pieces. */
function decompose(start, len, measureTicks, isRest = false) {
  const out = [];
  let pos = start;
  let remaining = len;
  while (remaining > 0) {
    let chosen = DURATIONS[DURATIONS.length - 1];
    for (const d of DURATIONS) {
      if (d.ticks > remaining) continue;
      if (d.ticks === 16 && measureTicks !== 16) continue; // whole note only in 4/4
      if (isRest && d.dots && !(start === 0 && len === measureTicks)) continue; // no dotted rests
      if (pos % d.align !== 0) continue;
      // Do not let a note cross the middle of a 4/4 bar unless it starts on a beat.
      const half = measureTicks / 2;
      if (measureTicks === 16 && pos < half && pos + d.ticks > half && pos % 4 !== 0) continue;
      chosen = d;
      break;
    }
    out.push(chosen.ticks);
    pos += chosen.ticks;
    remaining -= chosen.ticks;
  }
  return out;
}

export function durationInfo(ticks) {
  return DURATIONS.find((d) => d.ticks === ticks);
}

/**
 * Pick a clef from the note range. Returns 'treble' or 'bass'.
 */
export function autoClef(notes) {
  if (!notes.length) return 'treble';
  const sorted = notes.map((n) => n.midi).sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  return med < 57 ? 'bass' : 'treble';
}

function restKey(clef, ticks) {
  if (clef === 'bass') return ticks === 16 ? 'f/3' : 'd/3';
  return ticks === 16 ? 'd/5' : 'b/4';
}

/**
 * Render measures into a container using VexFlow.
 *
 * @param {HTMLElement} container
 * @param {Array<Array<Element>>} measures
 * @param {object} o { key, clef, timeSig, bpm }
 */
export function renderScore(container, measures, o) {
  const VF = window.Vex.Flow;
  container.innerHTML = '';

  const width = Math.max(320, (o.width || container.clientWidth) - 16);
  const firstExtra = 90;                          // room for clef + key + time
  const baseMeasureWidth = 230;
  const perLine = Math.max(1, Math.floor((width - firstExtra) / baseMeasureWidth));
  const lineHeight = 130;
  const lines = Math.max(1, Math.ceil(measures.length / perLine));

  const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
  renderer.resize(width, lines * lineHeight + 40);
  const ctx = renderer.getContext();
  ctx.setFont('Arial', 10);

  const timeSigStr = `${o.timeSig.beats}/${o.timeSig.beatValue}`;
  let pendingTie = null;                          // note awaiting its tie end across a line break
  let noteIndex = 0;

  for (let li = 0; li < lines; li++) {
    const lineMeasures = measures.slice(li * perLine, (li + 1) * perLine);
    if (lineMeasures.length === 0) break;
    const isLast = li === lines - 1;
    const usable = width - 10;
    const mWidth = isLast && lineMeasures.length < perLine
      ? baseMeasureWidth
      : (usable - firstExtra) / lineMeasures.length;
    let x = 5;
    const y = 20 + li * lineHeight;

    for (let mi = 0; mi < lineMeasures.length; mi++) {
      const els = lineMeasures[mi];
      const w = mWidth + (mi === 0 ? firstExtra : 0);
      const stave = new VF.Stave(x, y, w);
      if (mi === 0) {
        stave.addClef(o.clef).addKeySignature(o.key.name);
        if (li === 0) stave.addTimeSignature(timeSigStr);
      }
      if (li === lines - 1 && mi === lineMeasures.length - 1) stave.setEndBarType(VF.Barline.type.END);
      if (li === 0 && mi === 0 && o.bpm) {
        stave.setTempo({ duration: 'q', bpm: o.bpm }, -10);
      }
      stave.setContext(ctx).draw();

      const notes = [];
      const ties = [];
      for (const el of els) {
        const d = durationInfo(el.ticks);
        let sn;
        if (el.type === 'rest') {
          sn = new VF.StaveNote({ clef: o.clef, keys: [restKey(o.clef, el.ticks)], duration: d.vex + 'r' });
        } else {
          sn = new VF.StaveNote({ clef: o.clef, keys: [vexKey(el.midi, o.key)], duration: d.vex });
          if (el.live) sn.setStyle({ fillStyle: '#7a7a7a', strokeStyle: '#7a7a7a' });
        }
        if (d.dots) VF.Dot.buildAndAttach([sn], { all: true });
        sn.setAttribute('id', `n${noteIndex++}`);
        notes.push(sn);

        if (el.type === 'note') {
          if (el.tieEnd) {
            if (pendingTie) {
              ties.push(new VF.StaveTie({ first_note: pendingTie.note, last_note: sn, first_indices: [0], last_indices: [0] }));
            } else {
              ties.push(new VF.StaveTie({ first_note: null, last_note: sn, last_indices: [0] }));
            }
            pendingTie = null;
          }
          if (el.tieStart) pendingTie = { note: sn };
        }
      }

      const voice = new VF.Voice({ num_beats: o.timeSig.beats, beat_value: o.timeSig.beatValue }).setStrict(false);
      voice.addTickables(notes);
      VF.Accidental.applyAccidentals([voice], o.key.name);

      const beamGroups = o.timeSig.beatValue === 8
        ? [new VF.Fraction(3, 8)]
        : [new VF.Fraction(1, 4)];
      const beams = VF.Beam.generateBeams(notes, { groups: beamGroups, maintain_stem_directions: false });

      new VF.Formatter().joinVoices([voice]).formatToStave([voice], stave);
      voice.draw(ctx, stave);
      beams.forEach((b) => b.setContext(ctx).draw());
      ties.forEach((t) => t.setContext(ctx).draw());

      // A tie that continues past this line ends with a dangling half-tie.
      if (pendingTie && mi === lineMeasures.length - 1) {
        new VF.StaveTie({ first_note: pendingTie.note, last_note: null, first_indices: [0] }).setContext(ctx).draw();
        pendingTie = { note: null };
      }

      x += w;
    }
  }
}
