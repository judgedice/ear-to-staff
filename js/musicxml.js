/** MusicXML export for the quantized measures produced by notation.js. */
import { xmlPitch } from './theory.js';
import { durationInfo, TICKS_PER_QUARTER } from './notation.js';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {Array<Array<Element>>} measures
 * @param {object} o { key, clef, timeSig, bpm, title }
 * @returns {string} MusicXML document
 */
export function toMusicXML(measures, o) {
  const clefSign = o.clef === 'bass' ? 'F' : 'G';
  const clefLine = o.clef === 'bass' ? 4 : 2;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  lines.push('<score-partwise version="4.0">');
  lines.push(`  <work><work-title>${esc(o.title || 'Transcription')}</work-title></work>`);
  lines.push('  <identification><encoding><software>Ear to Staff</software></encoding></identification>');
  lines.push('  <part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list>');
  lines.push('  <part id="P1">');

  measures.forEach((els, i) => {
    lines.push(`    <measure number="${i + 1}">`);
    if (i === 0) {
      lines.push('      <attributes>');
      lines.push(`        <divisions>${TICKS_PER_QUARTER}</divisions>`);
      lines.push(`        <key><fifths>${o.key.fifths}</fifths><mode>${o.key.mode}</mode></key>`);
      lines.push(`        <time><beats>${o.timeSig.beats}</beats><beat-type>${o.timeSig.beatValue}</beat-type></time>`);
      lines.push(`        <clef><sign>${clefSign}</sign><line>${clefLine}</line></clef>`);
      lines.push('      </attributes>');
      if (o.bpm) {
        lines.push('      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>' +
          `<per-minute>${o.bpm}</per-minute></metronome></direction-type><sound tempo="${o.bpm}"/></direction>`);
      }
    }
    for (const el of els) {
      if (el.live) continue; // never export the in-progress note
      const d = durationInfo(el.ticks);
      lines.push('      <note>');
      if (el.type === 'rest') {
        lines.push('        <rest/>');
      } else {
        const p = xmlPitch(el.midi, o.key);
        lines.push('        <pitch>');
        lines.push(`          <step>${p.step}</step>`);
        if (p.alter) lines.push(`          <alter>${p.alter}</alter>`);
        lines.push(`          <octave>${p.octave}</octave>`);
        lines.push('        </pitch>');
      }
      lines.push(`        <duration>${el.ticks}</duration>`);
      if (el.type === 'note') {
        if (el.tieEnd) lines.push('        <tie type="stop"/>');
        if (el.tieStart) lines.push('        <tie type="start"/>');
      }
      lines.push(`        <type>${d.xml}</type>`);
      for (let k = 0; k < d.dots; k++) lines.push('        <dot/>');
      if (el.type === 'note' && (el.tieStart || el.tieEnd)) {
        lines.push('        <notations>');
        if (el.tieEnd) lines.push('          <tied type="stop"/>');
        if (el.tieStart) lines.push('          <tied type="start"/>');
        lines.push('        </notations>');
      }
      lines.push('      </note>');
    }
    lines.push('    </measure>');
  });

  lines.push('  </part>');
  lines.push('</score-partwise>');
  return lines.join('\n');
}
