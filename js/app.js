import { freqToMidi, midiToFreq } from './pitch.js';
import { NoteSegmenter } from './segmenter.js';
import { KEYS, keyByName, detectKey, fullName } from './theory.js';
import { quantize, renderScore, autoClef, parseTimeSig, ticksToSeconds, secondsToTicks } from './notation.js';
import { toMusicXML } from './musicxml.js';
import { detectFrames, segmentTrace, effectiveClarity, makeDetector, segmenterOptions } from './analysis.js';

const $ = (id) => document.getElementById(id);
const ui = {
  listen: $('btnListen'), openFile: $('btnOpenFile'), chooseFile: $('btnChooseFile'), clear: $('btnClear'), export: $('btnExport'), print: $('btnPrint'),
  play: $('btnPlay'), rewind: $('btnRewind'), playhead: $('playhead'), playheadFill: $('playheadFill'), playPos: $('playPos'), playSource: $('playSource'),
  liveName: $('liveName'), liveFreq: $('liveFreq'), liveCents: $('liveCents'), needle: $('tunerNeedle'),
  level: $('levelBar'), gateMark: $('gateMark'), status: $('status'),
  bpm: $('bpm'), tap: $('btnTap'), timeSig: $('timeSig'), swing: $('swing'), grid: $('grid'), key: $('key'), clef: $('clef'), a4: $('a4'),
  offsetBeats: $('offsetBeats'), offsetMinus: $('offsetMinus'), offsetPlus: $('offsetPlus'),
  metronome: $('metronome'), metronomeSilent: $('metronomeSilent'), beats: document.querySelector('.beats'), beatDots: $('beatDots'), beatLabel: $('beatLabel'),
  micDevice: $('micDevice'), micGain: $('micGain'), micGainVal: $('micGainVal'), micProcessing: $('micProcessing'),
  method: $('method'), sensitivity: $('sensitivity'), sensitivityVal: $('sensitivityVal'), clarity: $('clarity'), clarityVal: $('clarityVal'),
  vibrato: $('vibrato'), vibratoVal: $('vibratoVal'),
  rangePreset: $('rangePreset'), rangeLow: $('rangeLow'), rangeHigh: $('rangeHigh'),
  sourceTabs: document.querySelectorAll('.source-tabs button'),
  sourceMic: $('sourceMic'), sourceFile: $('sourceFile'), sourceTab: $('sourceTab'),
  dropZone: $('dropZone'), fileInput: $('fileInput'), fileName: $('fileName'), fromSec: $('fromSec'), toSec: $('toSec'),
  progressWrap: $('progressWrap'), progressBar: $('progressBar'), captureStatus: $('captureStatus'),
  traceWrap: $('traceWrap'), trace: $('trace'), traceCursor: $('traceCursor'),
  score: $('score'), scoreInfo: $('scoreInfo'),
};

const RANGE_PRESETS = {
  full: [33, 108],     // A1 – C8
  whistle: [81, 108],  // A5 – C8
  voice: [40, 84],     // E2 – C6
  guitar: [40, 88],    // E2 – E6
  bass: [28, 67],      // E1 – G4
  violin: [55, 100],   // G3 – E7
  cello: [36, 81],     // C2 – A5
  flute: [60, 96],     // C4 – C7
  piano: [21, 108],    // A0 – C8
};

// ---------------------------------------------------------------- Populate dropdowns
{
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = 'Auto detect';
  ui.key.appendChild(auto);
  for (const k of KEYS) {
    const opt = document.createElement('option');
    opt.value = k.name;
    opt.textContent = k.mode === 'minor' ? `${k.name.slice(0, -1)} minor` : `${k.name} major`;
    ui.key.appendChild(opt);
  }
  for (let m = 21; m <= 108; m++) {
    for (const sel of [ui.rangeLow, ui.rangeHigh]) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = `${fullName(m)} (${midiToFreq(m).toFixed(0)} Hz)`;
      sel.appendChild(opt);
    }
  }
  ui.rangeLow.value = String(RANGE_PRESETS.full[0]);
  ui.rangeHigh.value = String(RANGE_PRESETS.full[1]);
}

/**
 * Time bookkeeping.
 *
 * Notes are stored in "score time": seconds since bar 1 beat 1 (before the
 * bar-offset nudge, which is applied at quantization time).
 *
 * Microphone: the audio clock runs continuously, so each listening session has
 * an `anchor`, the audio time that corresponds to score time 0.
 *
 * File / tab capture: raw notes are in recording time (`fileNotes`); score time
 * is recording time minus `bufferAnchor` (the first detected note).
 */
const state = {
  source: 'mic',            // 'mic' | 'file' | 'tab'
  audioCtx: null,
  stream: null,
  sourceNode: null,
  gainNode: null,
  analyser: null,
  detector: null,
  segmenter: new NoteSegmenter(),
  buffer: null,
  timer: null,
  listening: false,
  anchor: null,
  resumeAt: 0,
  gateUntil: 0,
  countInDone: false,
  listenStart: null,
  notes: [],
  measures: [],
  lastRender: 0,
  metronomeTimer: null,
  nextClick: 0,
  clickIndex: 0,
  // file / capture
  audioBuffer: null,
  audioName: '',
  fileNotes: [],
  bufferAnchor: 0,
  trace: [],
  traceEff: [],
  traceHop: 0.01,
  traceRange: [0, 0],
  traceKey: '',
  analyzing: false,
  analysisId: 0,
  reanalyzeTimer: null,
  recorder: null,
  captureStream: null,
  captureChunks: [],
  captureTimer: null,
  captureStart: 0,
  taps: [],
};

const playback = {
  playing: false,
  nodes: [],
  raf: null,
  startAudioTime: 0,
  startTick: 0,
  positionTick: 0,
  totalTicks: 16,
  elements: [],
  highlighted: null,
  wasPlayingBeforeDrag: false,
};

function settings() {
  const bpm = clamp(parseFloat(ui.bpm.value) || 90, 30, 240);
  const timeSig = parseTimeSig(ui.timeSig.value);
  const grid = parseInt(ui.grid.value, 10);
  const swing = parseFloat(ui.swing.value) || 0.5;
  const keySel = ui.key.value;
  const key = keySel === 'auto' ? detectKey(state.notes) : keyByName(keySel);
  const clefSel = ui.clef.value;
  const clef = clefSel === 'auto' ? autoClef(state.notes) : clefSel;
  const a4 = clamp(parseFloat(ui.a4.value) || 440, 400, 480);
  const gateDb = parseFloat(ui.sensitivity.value);
  const clarity = parseInt(ui.clarity.value, 10) / 100;
  const changeCents = parseInt(ui.vibrato.value, 10);
  const beatSec = (60 / bpm) * (4 / timeSig.beatValue);
  const barSec = beatSec * timeSig.beats;
  const offsetBeats = clamp(parseFloat(ui.offsetBeats.value) || 0, 0, 12);
  let lowMidi = parseInt(ui.rangeLow.value, 10);
  let highMidi = parseInt(ui.rangeHigh.value, 10);
  if (lowMidi > highMidi) [lowMidi, highMidi] = [highMidi, lowMidi];
  return {
    bpm, timeSig, grid, swing, key, clef, a4, beatSec, barSec, clarity, changeCents, lowMidi, highMidi, offsetBeats,
    method: ui.method.value,
    t0: -offsetBeats * beatSec,
    gateRms: Math.pow(10, gateDb / 20),
    micGain: parseFloat(ui.micGain.value) || 1,
  };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function setStatus(msg, isError = false) {
  ui.status.innerHTML = msg;
  ui.status.classList.toggle('error', isError);
}

function nextBarStart(s) {
  if (!state.notes.length) return 0;
  const end = Math.max(...state.notes.map((n) => n.end));
  return Math.ceil(end / s.barSec - 1e-6) * s.barSec;
}

function ensureAudioContext() {
  if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
  return state.audioCtx;
}

// ---------------------------------------------------------------- Source switching

function setSource(src) {
  if (state.listening) stopListening();
  if (state.recorder) cancelCapture();
  stopPlayback();
  state.source = src;
  ui.sourceTabs.forEach((b) => b.classList.toggle('active', b.dataset.source === src));
  ui.sourceMic.hidden = src !== 'mic';
  ui.sourceFile.hidden = src !== 'file';
  ui.sourceTab.hidden = src !== 'tab';
  ui.metronome.disabled = src !== 'mic';
  updateMainButton();
  if (src === 'mic') {
    setStatus('Press <b>Start listening</b> and allow microphone access.');
  } else if (src === 'file') {
    setStatus(state.audioBuffer ? `Loaded ${state.audioName}.` : 'Press <b>Open audio file…</b> or drop a file on the box. For whistling, choose the <b>Whistle</b> pitch range.');
  } else {
    setStatus('Press <b>Start capture</b>, pick the tab that is playing, and tick <b>Share tab audio</b>.');
  }
}

function updateMainButton() {
  const b = ui.listen;
  b.classList.remove('listening');
  b.classList.toggle('primary', state.source !== 'file');
  ui.openFile.classList.toggle('primary', state.source === 'file');
  if (state.source === 'mic') {
    b.textContent = state.listening ? '■ Stop listening' : '● Start listening';
    b.classList.toggle('listening', state.listening);
    b.disabled = false;
  } else if (state.source === 'file') {
    b.textContent = state.analyzing ? '… Analyzing' : '↻ Re-analyze';
    b.disabled = !state.audioBuffer || state.analyzing;
  } else {
    b.textContent = state.recorder ? '■ Stop capture & analyze' : '● Start capture';
    b.classList.toggle('listening', !!state.recorder);
    b.disabled = state.analyzing;
  }
}

// ---------------------------------------------------------------- Microphone

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const chosen = ui.micDevice.value;
    ui.micDevice.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default microphone';
    ui.micDevice.appendChild(def);
    inputs.forEach((d, i) => {
      if (!d.deviceId || d.deviceId === 'default') return;
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      ui.micDevice.appendChild(opt);
    });
    if ([...ui.micDevice.options].some((o) => o.value === chosen)) ui.micDevice.value = chosen;
  } catch (err) {
    console.warn('enumerateDevices failed', err);
  }
}

function micConstraints() {
  const processing = ui.micProcessing.checked;
  const audio = { echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing };
  if (ui.micDevice.value) audio.deviceId = { exact: ui.micDevice.value };
  return { audio };
}

async function openStream() {
  const ctx = ensureAudioContext();
  const stream = await navigator.mediaDevices.getUserMedia(micConstraints());
  closeStream();
  attachStream(stream, ctx);
  await refreshDevices();
}

/** Route any MediaStream into gain -> analyser for live analysis / metering. */
function attachStream(stream, ctx) {
  state.stream = stream;
  state.sourceNode = ctx.createMediaStreamSource(stream);
  if (!state.gainNode) state.gainNode = ctx.createGain();
  if (!state.analyser) {
    state.analyser = ctx.createAnalyser();
    state.analyser.smoothingTimeConstant = 0;
    state.gainNode.connect(state.analyser);
  }
  state.gainNode.gain.value = settings().micGain;
  state.sourceNode.connect(state.gainNode);
  applyDetectionSettings();
}

function closeStream() {
  if (state.sourceNode) { try { state.sourceNode.disconnect(); } catch (_) { /* noop */ } }
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.sourceNode = null;
  state.stream = null;
}

/** Push detection settings into the live detector and analyser. */
function applyDetectionSettings() {
  const s = settings();
  state.segmenter.clarityThreshold = s.clarity;
  state.segmenter.gateRms = s.gateRms;
  state.segmenter.changeCents = s.changeCents;
  if (!state.audioCtx || !state.analyser) return;
  const { detector, frameSize } = makeDetector(s.method, state.audioCtx.sampleRate, s.lowMidi, s.highMidi, s.a4);
  if (state.analyser.fftSize !== frameSize) state.analyser.fftSize = frameSize;
  if (!state.buffer || state.buffer.length !== frameSize) state.buffer = new Float32Array(frameSize);
  // Keep the detector instance when nothing structural changed, so the whistle tracker keeps its continuity.
  if (!state.detector || state.detector.constructor !== detector.constructor || state.detector.n !== detector.n) {
    state.detector = detector;
  } else {
    state.detector.minFreq = detector.minFreq;
    state.detector.maxFreq = detector.maxFreq;
  }
}

// ---------------------------------------------------------------- Live listening (microphone)

async function startListening() {
  try {
    ensureAudioContext();
    stopPlayback();
    const s = settings();
    state.segmenter = new NoteSegmenter({ ...segmenterOptions(0.016, s) });
    await openStream();

    state.listenStart = state.audioCtx.currentTime;
    state.resumeAt = nextBarStart(s);
    state.countInDone = false;
    const barLabel = state.resumeAt > 0 ? `bar ${Math.round(state.resumeAt / s.barSec) + 1}` : 'bar 1';

    if (ui.metronome.checked) {
      state.gateUntil = state.listenStart + s.barSec;
      state.anchor = state.gateUntil - state.resumeAt;
      startMetronome(s);
      setStatus(`Count-in… ${barLabel} starts after one bar of clicks.`);
    } else {
      state.gateUntil = 0;
      state.anchor = null;
      setStatus(`Listening. Your first note becomes the downbeat of ${barLabel}.`);
    }

    state.listening = true;
    updateMainButton();
    state.timer = setInterval(processFrame, 16);
  } catch (err) {
    console.error(err);
    closeStream();
    setStatus(`Microphone unavailable: ${err.message}. Check browser permissions.`, true);
  }
}

function stopListening() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  stopMetronome();
  if (state.audioCtx) {
    const finished = state.segmenter.flush(state.audioCtx.currentTime);
    for (const n of finished) addNote(n);
  }
  closeStream();
  state.listening = false;
  updateMainButton();
  resetLiveDisplay('Stopped');
  showBeat(null, 'Metronome off');
  setStatus(state.notes.length
    ? `Captured ${state.notes.length} note${state.notes.length === 1 ? '' : 's'}. Play it back, export, or press Start to add more bars.`
    : 'Nothing captured. Try lowering the noise gate, raising input gain, or getting closer to the mic.');
  render(true);
}

function processFrame() {
  const s = settings();
  state.analyser.getFloatTimeDomainData(state.buffer);
  const t = state.audioCtx.currentTime;
  const { freq, clarity, rms } = state.detector.detect(state.buffer);
  let midi = Number.isFinite(freq) ? freqToMidi(freq, s.a4) : NaN;
  if (Number.isFinite(midi)) {
    const r = Math.round(midi);
    if (r < s.lowMidi || r > s.highMidi) midi = NaN;
  }

  const inCountIn = t < state.gateUntil;
  if (!inCountIn && state.gateUntil && !state.countInDone) {
    state.countInDone = true;
    const bar = Math.round(state.resumeAt / s.barSec) + 1;
    setStatus(`Recording from bar ${bar}. Press Stop when you are done.`);
  }
  const finished = inCountIn ? [] : state.segmenter.push({ t, midi, clarity, rms });
  for (const n of finished) addNote(n);

  if (state.anchor === null && state.segmenter.live) {
    state.anchor = state.segmenter.live.start - state.resumeAt;
  }

  updateLiveDisplay(midi, freq, clarity, rms, s);
  updateBeatVizRecording(t, s);
  if (t - state.lastRender > 0.12) render(false);
}

function addNote(n) {
  if (state.anchor === null) return;
  const start = n.start - state.anchor;
  const end = n.end - state.anchor;
  if (end <= 0) return;
  state.notes.push({ start: Math.max(0, start), end, midi: n.midi, cents: n.cents });
  setHasNotes(true);
}

function setHasNotes(has) {
  ui.play.disabled = ui.rewind.disabled = ui.playhead.disabled = ui.export.disabled = ui.print.disabled = !has;
}

function updateLiveDisplay(midi, freq, clarity, rms, s) {
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  ui.level.style.width = `${clamp(((db + 80) / 80) * 100, 0, 100)}%`;

  const voiced = Number.isFinite(midi) && clarity >= s.clarity && rms >= s.gateRms;
  if (voiced) {
    const rounded = Math.round(midi);
    const cents = Math.round((midi - rounded) * 100);
    const name = fullName(rounded, s.key);
    const m = name.match(/^([A-G][#b]?)(-?\d+)$/);
    ui.liveName.innerHTML = m ? `${m[1]}<sub>${m[2]}</sub>` : name;
    ui.liveFreq.textContent = `${freq.toFixed(1)} Hz · clarity ${(clarity * 100).toFixed(0)}%`;
    ui.liveCents.textContent = `${cents > 0 ? '+' : ''}${cents} cents`;
    ui.needle.style.left = `${50 + clamp(cents, -50, 50)}%`;
    ui.needle.classList.add('active');
  } else {
    ui.needle.classList.remove('active');
    ui.liveCents.textContent = 'cents';
    if (!state.segmenter.live) {
      ui.liveName.textContent = '—';
      ui.liveFreq.textContent = rms < s.gateRms ? 'Below noise gate' : (Number.isFinite(freq) ? 'Unclear pitch' : 'Listening…');
    }
  }
}

function resetLiveDisplay(msg) {
  ui.needle.classList.remove('active');
  ui.level.style.width = '0%';
  ui.liveName.textContent = '—';
  ui.liveFreq.textContent = msg;
  ui.liveCents.textContent = 'cents';
}

function updateSettingLabels() {
  const gateDb = parseFloat(ui.sensitivity.value);
  ui.sensitivityVal.textContent = `${gateDb < 0 ? '−' : ''}${Math.abs(gateDb)} dB`;
  ui.gateMark.style.left = `${clamp(((gateDb + 80) / 80) * 100, 0, 100)}%`;
  ui.clarityVal.textContent = `${ui.clarity.value}%`;
  ui.vibratoVal.textContent = `${ui.vibrato.value} cents`;
  ui.micGainVal.textContent = `×${parseFloat(ui.micGain.value).toFixed(2).replace(/0$/, '')}`;
}

// ---------------------------------------------------------------- Beat visualizer

function buildBeatDots(beats) {
  if (ui.beatDots.childElementCount === beats) return;
  ui.beatDots.innerHTML = '';
  for (let i = 0; i < beats; i++) {
    const d = document.createElement('div');
    d.className = 'beat-dot' + (i === 0 ? ' downbeat' : '');
    ui.beatDots.appendChild(d);
  }
}

function showBeat(beatIndex, label, countIn = false) {
  const s = settings();
  buildBeatDots(s.timeSig.beats);
  const dots = ui.beatDots.children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('active', i === beatIndex);
  ui.beatLabel.textContent = label;
  ui.beats.classList.toggle('countin', countIn);
}

function updateBeatVizRecording(t, s) {
  if (!ui.metronome.checked) {
    showBeat(null, state.listening ? 'Free time' : 'Metronome off');
    return;
  }
  const beatsPerBar = s.timeSig.beats;
  const elapsed = t - state.listenStart;
  const beatIdx = Math.floor(elapsed / s.beatSec + 1e-6);
  const inBar = ((beatIdx % beatsPerBar) + beatsPerBar) % beatsPerBar;
  if (t < state.gateUntil) {
    showBeat(inBar, `Count-in ${inBar + 1}`, true);
  } else {
    const bar = Math.floor((t - state.anchor) / s.barSec) + 1;
    showBeat(inBar, `Bar ${bar} · beat ${inBar + 1}`);
  }
}

function updateBeatVizPlayback(tick, s) {
  const beatTicks = 16 / s.timeSig.beatValue;
  const inBar = Math.floor((tick % s.timeSig.ticks) / beatTicks);
  showBeat(inBar, positionLabel(Math.floor(tick), s));
}

// ---------------------------------------------------------------- Metronome

function startMetronome(s) {
  const ctx = state.audioCtx;
  state.nextClick = state.listenStart + 0.05;
  state.clickIndex = 0;
  const schedule = () => {
    while (state.nextClick < ctx.currentTime + 0.2) {
      const isDownbeat = state.clickIndex % s.timeSig.beats === 0;
      if (!ui.metronomeSilent.checked) click(ctx, state.nextClick, isDownbeat);
      state.nextClick += s.beatSec;
      state.clickIndex++;
    }
  };
  schedule();
  state.metronomeTimer = setInterval(schedule, 80);
}

function stopMetronome() {
  if (state.metronomeTimer) clearInterval(state.metronomeTimer);
  state.metronomeTimer = null;
}

function click(ctx, when, accent) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = accent ? 1800 : 1200;
  gain.gain.setValueAtTime(accent ? 0.25 : 0.15, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + 0.03);
  osc.connect(gain).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + 0.04);
}

// ---------------------------------------------------------------- Tap tempo

function tapTempo() {
  const now = performance.now() / 1000;
  if (state.taps.length && now - state.taps[state.taps.length - 1] > 2.5) state.taps = [];
  state.taps.push(now);
  if (state.taps.length > 9) state.taps.shift();
  ui.tap.classList.add('flash');
  setTimeout(() => ui.tap.classList.remove('flash'), 90);
  if (state.taps.length < 2) {
    ui.tap.textContent = 'Tap… (1)';
    return;
  }
  const diffs = [];
  for (let i = 1; i < state.taps.length; i++) diffs.push(state.taps[i] - state.taps[i - 1]);
  diffs.sort((a, b) => a - b);
  const med = diffs[diffs.length >> 1];
  const bpm = Math.round(60 / med);
  ui.tap.textContent = `Tap… (${state.taps.length}) ${bpm}`;
  if (bpm >= 30 && bpm <= 240) {
    ui.bpm.value = String(bpm);
    refreshFromSettings();
  }
}

// ---------------------------------------------------------------- Audio file

async function loadFile(file) {
  if (!file) return;
  try {
    const ctx = ensureAudioContext();
    setStatus(`Decoding ${file.name}…`);
    const arr = await file.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr);
    setAudioBuffer(buf, file.name);
    await runAnalysis();
  } catch (err) {
    console.error(err);
    setStatus(`Could not decode that file: ${err.message}`, true);
  }
}

function setAudioBuffer(buf, name) {
  state.audioBuffer = buf;
  state.audioName = name;
  state.fileNotes = [];
  state.notes = [];
  state.trace = [];
  state.traceEff = [];
  state.traceKey = '';
  ui.fileName.textContent = `${name} · ${fmtTime(buf.duration)} · ${buf.sampleRate} Hz`;
  ui.fromSec.value = '0';
  ui.toSec.value = buf.duration.toFixed(1);
  ui.toSec.max = ui.fromSec.max = buf.duration.toFixed(1);
  ui.playSource.hidden = false;
  ui.traceWrap.hidden = false;
  updateMainButton();
}

async function runAnalysis() {
  if (!state.audioBuffer || state.analyzing) return;
  const s = settings();
  const id = ++state.analysisId;
  state.analyzing = true;
  stopPlayback();
  updateMainButton();
  ui.progressWrap.hidden = false;
  ui.progressBar.style.width = '0%';
  const from = parseFloat(ui.fromSec.value) || 0;
  const to = parseFloat(ui.toSec.value) || state.audioBuffer.duration;
  const methodLabel = s.method === 'whistle' ? 'spectral peak' : 'autocorrelation';
  setStatus(`Analyzing ${fmtTime(from)}–${fmtTime(to)} with ${methodLabel}…`);

  try {
    const result = await detectFrames(
      state.audioBuffer,
      { ...s, from, to },
      (f) => { ui.progressBar.style.width = `${(f * 100).toFixed(1)}%`; },
      () => id !== state.analysisId,
    );
    if (!result || id !== state.analysisId) return;
    state.trace = result.trace;
    state.traceHop = result.hopSec;
    state.traceRange = [result.from, result.to];
    state.traceKey = detectionKey(s, from, to);
    resegment();
  } catch (err) {
    console.error(err);
    setStatus(`Analysis failed: ${err.message}`, true);
  } finally {
    if (id === state.analysisId) {
      state.analyzing = false;
      ui.progressWrap.hidden = true;
      updateMainButton();
    }
  }
}

/** Settings that require running the detector again (as opposed to re-segmenting). */
function detectionKey(s, from, to) {
  return [s.method, s.lowMidi, s.highMidi, s.a4, from, to].join('|');
}

/** Re-run only the cheap segmentation stage on the stored trace. */
function resegment() {
  if (!state.trace.length) return;
  const s = settings();
  state.traceEff = effectiveClarity(state.trace);
  state.fileNotes = segmentTrace(state.trace, state.traceHop, s, state.traceRange[1]);
  applyFileNotes();
  const n = state.fileNotes.length;
  setStatus(n
    ? `Found ${n} note${n === 1 ? '' : 's'}. Tap the tempo, pick a feel, and nudge Bar 1 offset until the bars line up. Press Play with <b>Original</b> to check.`
    : 'No notes found. Lower pitch clarity or the noise gate, widen the pitch range, or check the Analyze from/to window.');
}

/** Convert recording-time notes into score time anchored at the first note. */
function applyFileNotes() {
  const notes = state.fileNotes;
  state.bufferAnchor = notes.length ? notes[0].start : (state.traceRange[0] || 0);
  state.notes = notes.map((n) => ({ start: n.start - state.bufferAnchor, end: n.end - state.bufferAnchor, midi: n.midi, cents: n.cents }));
  setHasNotes(state.notes.length > 0);
  render(true);
  drawTrace();
}

/** Recording time for a given score time, including the bar offset. */
function bufferTimeAt(scoreSec, s) {
  return state.bufferAnchor + scoreSec + (s.t0);
}

function scheduleReanalysis() {
  if (!state.audioBuffer || state.source === 'mic') return;
  const s = settings();
  const from = parseFloat(ui.fromSec.value) || 0;
  const to = parseFloat(ui.toSec.value) || state.audioBuffer.duration;
  if (state.trace.length && detectionKey(s, from, to) === state.traceKey) {
    // Only clarity / gate / vibrato changed: instant.
    clearTimeout(state.reanalyzeTimer);
    state.reanalyzeTimer = setTimeout(resegment, 120);
    return;
  }
  clearTimeout(state.reanalyzeTimer);
  state.reanalyzeTimer = setTimeout(() => {
    state.analysisId++;          // cancels any run in progress
    state.analyzing = false;
    runAnalysis();
  }, 400);
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------- Browser tab capture

async function startCapture() {
  try {
    ensureAudioContext();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      selfBrowserSurface: 'exclude',
      systemAudio: 'include',
    });
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      setStatus('No audio in that capture. Pick a <b>Chrome tab</b> and tick <b>Share tab audio</b> in the picker.', true);
      return;
    }
    stream.getVideoTracks().forEach((t) => t.stop()); // audio only
    const audioStream = new MediaStream(audioTracks);
    state.captureStream = audioStream;
    state.captureChunks = [];
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(audioStream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size) state.captureChunks.push(e.data); };
    rec.onstop = finishCapture;
    rec.start(1000);
    state.recorder = rec;
    state.captureStart = performance.now();
    audioTracks[0].addEventListener('ended', () => { if (state.recorder) stopCapture(); });

    // Live meter while capturing.
    attachStream(audioStream, state.audioCtx);
    state.timer = setInterval(captureMeterFrame, 50);
    state.captureTimer = setInterval(() => {
      ui.captureStatus.textContent = `Capturing… ${fmtTime((performance.now() - state.captureStart) / 1000)}`;
    }, 200);
    updateMainButton();
    setStatus('Capturing tab audio. Play the passage you want, then press <b>Stop capture &amp; analyze</b>.');
  } catch (err) {
    console.error(err);
    setStatus(err.name === 'NotAllowedError' ? 'Capture cancelled.' : `Capture failed: ${err.message}`, true);
  }
}

function captureMeterFrame() {
  if (!state.analyser) return;
  state.analyser.getFloatTimeDomainData(state.buffer);
  let acc = 0;
  for (let i = 0; i < state.buffer.length; i++) acc += state.buffer[i] * state.buffer[i];
  const rms = Math.sqrt(acc / state.buffer.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  ui.level.style.width = `${clamp(((db + 80) / 80) * 100, 0, 100)}%`;
  ui.liveFreq.textContent = 'Capturing tab audio…';
}

function stopCapture() {
  if (!state.recorder) return;
  const rec = state.recorder;
  state.recorder = null;
  clearInterval(state.timer); state.timer = null;
  clearInterval(state.captureTimer); state.captureTimer = null;
  if (rec.state !== 'inactive') rec.stop(); else finishCapture();
  updateMainButton();
}

function cancelCapture() {
  if (state.recorder) {
    state.recorder.onstop = null;
    try { state.recorder.stop(); } catch (_) { /* noop */ }
    state.recorder = null;
  }
  clearInterval(state.timer); state.timer = null;
  clearInterval(state.captureTimer); state.captureTimer = null;
  if (state.captureStream) state.captureStream.getTracks().forEach((t) => t.stop());
  state.captureStream = null;
  closeStream();
  ui.captureStatus.textContent = '';
}

async function finishCapture() {
  const chunks = state.captureChunks;
  const mime = chunks[0]?.type || 'audio/webm';
  if (state.captureStream) state.captureStream.getTracks().forEach((t) => t.stop());
  state.captureStream = null;
  closeStream();
  resetLiveDisplay('Capture stopped');
  ui.captureStatus.textContent = '';
  if (!chunks.length) {
    setStatus('Nothing was captured.', true);
    return;
  }
  try {
    const blob = new Blob(chunks, { type: mime });
    setStatus('Decoding capture…');
    const buf = await ensureAudioContext().decodeAudioData(await blob.arrayBuffer());
    setAudioBuffer(buf, `tab capture ${new Date().toLocaleTimeString()}`);
    ui.fileName.textContent = `Captured ${fmtTime(buf.duration)} of tab audio`;
    await runAnalysis();
  } catch (err) {
    console.error(err);
    setStatus(`Could not decode the capture: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------- Pitch trace

function drawTrace() {
  const canvas = ui.trace;
  if (!state.trace.length) { ui.traceWrap.hidden = true; return; }
  ui.traceWrap.hidden = false;
  const s = settings();
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600, cssH = 150;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const [t0, t1] = state.traceRange;
  const span = Math.max(0.1, t1 - t0);
  const voiced = state.trace.filter((f) => Number.isFinite(f.midi));
  let lo = s.lowMidi, hi = s.highMidi;
  if (voiced.length) {
    const ms = voiced.map((f) => f.midi).sort((a, b) => a - b);
    lo = Math.floor(ms[Math.floor(ms.length * 0.02)]) - 2;
    hi = Math.ceil(ms[Math.floor(ms.length * 0.98)]) + 2;
    if (hi - lo < 12) { const c = (hi + lo) / 2; lo = c - 6; hi = c + 6; }
  }
  const x = (t) => ((t - t0) / span) * cssW;
  const y = (m) => cssH - ((m - lo) / (hi - lo)) * cssH;

  // Octave grid lines (C notes) and bar lines.
  ctx.strokeStyle = '#1f252d'; ctx.lineWidth = 1;
  for (let m = Math.ceil(lo); m <= hi; m++) {
    if (m % 12 === 0) { ctx.beginPath(); ctx.moveTo(0, y(m)); ctx.lineTo(cssW, y(m)); ctx.stroke(); }
  }
  if (state.notes.length) {
    ctx.strokeStyle = '#2a313b';
    const totalBars = Math.ceil(secondsToTicks(state.notes[state.notes.length - 1].end - s.t0, s) / s.timeSig.ticks) + 1;
    for (let b = 0; b <= totalBars; b++) {
      const bt = bufferTimeAt(ticksToSeconds(b * s.timeSig.ticks, s), s);
      if (bt < t0 || bt > t1) continue;
      ctx.beginPath(); ctx.moveTo(x(bt), 0); ctx.lineTo(x(bt), cssH); ctx.stroke();
    }
  }

  // Frames.
  const eff = state.traceEff.length === state.trace.length ? state.traceEff : state.trace.map((f) => f.clarity);
  for (let i = 0; i < state.trace.length; i++) {
    const f = state.trace[i];
    if (!Number.isFinite(f.midi)) continue;
    const ok = eff[i] >= s.clarity && f.rms >= s.gateRms;
    ctx.fillStyle = ok ? 'rgba(79,209,197,0.9)' : 'rgba(138,148,163,0.35)';
    ctx.fillRect(x(f.t), y(f.midi) - 1, Math.max(1, cssW / state.trace.length), 2);
  }
  // Notes.
  ctx.fillStyle = 'rgba(245,185,66,0.85)';
  for (const n of state.fileNotes) {
    ctx.fillRect(x(n.start), y(n.midi) - 3, Math.max(2, x(n.end) - x(n.start)), 6);
  }
  // Note names on the left for C's.
  ctx.fillStyle = '#8a94a3'; ctx.font = '10px sans-serif';
  for (let m = Math.ceil(lo); m <= hi; m++) if (m % 12 === 0) ctx.fillText(fullName(m), 3, y(m) - 2);
}

function updateTraceCursor(tick, s) {
  if (!state.audioBuffer || ui.traceWrap.hidden) return;
  const [t0, t1] = state.traceRange;
  const bt = bufferTimeAt(ticksToSeconds(tick, s), s);
  const frac = (bt - t0) / Math.max(0.1, t1 - t0);
  ui.traceCursor.style.left = frac >= 0 && frac <= 1 ? `${frac * 100}%` : '-10px';
}

// ---------------------------------------------------------------- Rendering

function currentNotesForRender() {
  const notes = state.notes.slice();
  const live = state.segmenter.live;
  if (state.listening && live && state.anchor !== null && state.audioCtx) {
    const start = live.start - state.anchor;
    const end = state.audioCtx.currentTime - state.anchor;
    if (end > 0) notes.push({ start: Math.max(0, start), end, midi: live.midi, live: true });
  }
  return notes;
}

function render(force) {
  const s = settings();
  const notes = currentNotesForRender();
  state.lastRender = state.audioCtx ? state.audioCtx.currentTime : performance.now() / 1000;

  state.measures = quantize(notes, s);
  if (notes.length === 0) {
    ui.scoreInfo.textContent = 'No notes yet';
  } else {
    const bars = state.measures.length;
    const keyLabel = s.key.mode === 'minor' ? `${s.key.name.slice(0, -1)} minor` : `${s.key.name} major`;
    ui.scoreInfo.textContent = `${state.notes.length} notes · ${bars} bar${bars === 1 ? '' : 's'} · ${keyLabel} · ${s.clef} clef`;
  }
  try {
    renderScore(ui.score, state.measures, s);
  } catch (err) {
    console.error(err);
    if (force) setStatus(`Render error: ${err.message}`, true);
  }
  if (!playback.playing) rebuildPlaybackTimeline(s);
}

/** Re-render and redraw after any rhythm/notation setting changes. */
function refreshFromSettings() {
  stopPlayback();
  render(true);
  drawTrace();
}

// ---------------------------------------------------------------- Playback + transport

function rebuildPlaybackTimeline(s) {
  const measures = quantize(state.notes, s);
  const elements = [];
  let tick = 0, idx = 0;
  for (const m of measures) {
    for (const el of m) {
      elements.push({ idx: idx++, tick, ...el });
      tick += el.ticks;
    }
  }
  playback.elements = elements;
  playback.totalTicks = Math.max(tick, s.timeSig.ticks);
  ui.playhead.max = String(playback.totalTicks);
  if (playback.positionTick > playback.totalTicks) playback.positionTick = 0;
  updateTransportUI(playback.positionTick, s);
}

function positionLabel(tick, s) {
  const mTicks = s.timeSig.ticks;
  const beatTicks = 16 / s.timeSig.beatValue;
  const bar = Math.floor(tick / mTicks) + 1;
  const beat = Math.floor((tick % mTicks) / beatTicks) + 1;
  return `Bar ${bar} · beat ${beat}`;
}

function updateTransportUI(tick, s) {
  const clamped = clamp(tick, 0, playback.totalTicks);
  ui.playhead.value = String(Math.floor(clamped));
  ui.playheadFill.style.width = `${(clamped / playback.totalTicks) * 100}%`;
  ui.playPos.textContent = positionLabel(Math.floor(clamped), s);
  highlightAt(clamped);
  updateTraceCursor(clamped, s);
  if (playback.playing) updateBeatVizPlayback(clamped, s);
}

function highlightAt(tick) {
  const el = playback.elements.find((e) => tick >= e.tick && tick < e.tick + e.ticks);
  const idx = el && el.type === 'note' ? el.idx : null;
  if (idx === playback.highlighted) return;
  if (playback.highlighted !== null) document.getElementById(`vf-n${playback.highlighted}`)?.classList.remove('vf-playing');
  if (idx !== null) document.getElementById(`vf-n${idx}`)?.classList.add('vf-playing');
  playback.highlighted = idx;
}

function currentTick() {
  if (!playback.playing) return playback.positionTick;
  const s = settings();
  const elapsed = state.audioCtx.currentTime - playback.startAudioTime;
  return secondsToTicks(ticksToSeconds(playback.startTick, s) + elapsed, s);
}

function playFrom(tick) {
  const s = settings();
  const ctx = ensureAudioContext();
  stopNodes();
  rebuildPlaybackTimeline(s);
  if (tick >= playback.totalTicks) tick = 0;

  const start = ctx.currentTime + 0.05;
  playback.startAudioTime = start;
  playback.startTick = tick;
  playback.playing = true;

  const mode = state.audioBuffer && !ui.playSource.hidden ? ui.playSource.value : 'synth';
  const startSec = ticksToSeconds(tick, s);

  if (mode === 'synth' || mode === 'both') {
    const vol = mode === 'both' ? 0.18 : 0.3;
    let pendingStart = null;
    for (const el of playback.elements) {
      if (el.type !== 'note') continue;
      if (!el.tieEnd) pendingStart = el.tick;
      if (el.tieStart) continue;
      const onTick = pendingStart ?? el.tick;
      const offTick = el.tick + el.ticks;
      if (offTick <= tick) continue;
      const on = start + Math.max(0, ticksToSeconds(onTick, s) - startSec);
      const off = start + ticksToSeconds(offTick, s) - startSec;
      tone(ctx, midiToFreq(el.midi, s.a4), on, off, vol);
    }
  }
  if ((mode === 'original' || mode === 'both') && state.audioBuffer) {
    const src = ctx.createBufferSource();
    src.buffer = state.audioBuffer;
    const offset = bufferTimeAt(startSec, s);
    const dur = ticksToSeconds(playback.totalTicks, s) - startSec;
    if (offset < state.audioBuffer.duration) {
      src.connect(ctx.destination);
      src.start(start + Math.max(0, -offset), Math.max(0, offset), dur);
      playback.nodes.push(src);
    }
  }

  ui.play.textContent = '❚❚';
  const loop = () => {
    if (!playback.playing) return;
    const cur = currentTick();
    if (cur >= playback.totalTicks) {
      playback.playing = false;
      playback.positionTick = 0;
      stopNodes();
      ui.play.textContent = '▶';
      updateTransportUI(0, settings());
      return;
    }
    updateTransportUI(cur, settings());
    playback.raf = requestAnimationFrame(loop);
  };
  playback.raf = requestAnimationFrame(loop);
}

function pausePlayback() {
  if (!playback.playing) return;
  playback.positionTick = Math.min(currentTick(), playback.totalTicks);
  playback.playing = false;
  stopNodes();
  ui.play.textContent = '▶';
  updateTransportUI(playback.positionTick, settings());
  if (!state.listening) showBeat(null, 'Paused');
}

function stopPlayback() {
  playback.playing = false;
  playback.positionTick = 0;
  stopNodes();
  ui.play.textContent = '▶';
  updateTransportUI(0, settings());
  if (!state.listening) showBeat(null, 'Metronome off');
}

function stopNodes() {
  if (playback.raf) cancelAnimationFrame(playback.raf);
  playback.raf = null;
  for (const n of playback.nodes) { try { n.stop(); } catch (_) { /* already stopped */ } }
  playback.nodes = [];
}

function tone(ctx, freq, on, off, vol = 0.3) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, on);
  gain.gain.exponentialRampToValueAtTime(vol, on + 0.01);
  gain.gain.setValueAtTime(vol, Math.max(on + 0.01, off - 0.04));
  gain.gain.exponentialRampToValueAtTime(0.0001, off);
  osc.connect(gain).connect(ctx.destination);
  osc.start(on);
  osc.stop(off + 0.01);
  playback.nodes.push(osc);
}

function seekTo(tick) {
  playback.positionTick = clamp(tick, 0, playback.totalTicks);
  updateTransportUI(playback.positionTick, settings());
}

// ---------------------------------------------------------------- Export

function exportMusicXML() {
  const s = settings();
  const measures = quantize(state.notes, s);
  const xml = toMusicXML(measures, { ...s, title: state.audioName ? `Transcription of ${state.audioName}` : 'Transcription' });
  const blob = new Blob([xml], { type: 'application/vnd.recordare.musicxml+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.download = `transcription-${stamp}.musicxml`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  setStatus('MusicXML downloaded. Open it in MuseScore, Finale, Sibelius, or Dorico.');
}

// ---------------------------------------------------------------- Wiring

ui.sourceTabs.forEach((b) => b.addEventListener('click', () => setSource(b.dataset.source)));

ui.listen.addEventListener('click', () => {
  if (state.source === 'mic') return state.listening ? stopListening() : startListening();
  if (state.source === 'file') return runAnalysis();
  return state.recorder ? stopCapture() : startCapture();
});

ui.clear.addEventListener('click', () => {
  stopPlayback();
  // Drop any loaded recording too, and cancel analysis in flight, so nothing refills the score later.
  clearTimeout(state.reanalyzeTimer);
  state.analysisId++;
  state.analyzing = false;
  state.audioBuffer = null;
  state.audioName = '';
  ui.fileName.textContent = 'MP3, M4A, WAV, FLAC, OGG…';
  ui.fileInput.value = '';
  ui.playSource.hidden = true;
  ui.progressWrap.hidden = true;
  state.notes = [];
  state.fileNotes = [];
  state.trace = [];
  state.traceEff = [];
  state.traceKey = '';
  state.segmenter.reset();
  state.resumeAt = 0;
  if (state.listening && ui.metronome.checked) {
    const s = settings();
    const now = state.audioCtx.currentTime;
    const base = state.gateUntil;
    state.anchor = base + Math.ceil((now - base) / s.barSec) * s.barSec;
  } else {
    state.anchor = null;
  }
  ui.traceWrap.hidden = true;
  setHasNotes(false);
  updateMainButton();
  setStatus(state.listening ? 'Cleared. Still listening.' : 'Cleared.');
  render(true);
});
ui.export.addEventListener('click', exportMusicXML);
ui.print.addEventListener('click', () => window.print());

// File input + drag/drop
const openPicker = () => { setSource('file'); ui.fileInput.click(); };
ui.openFile.addEventListener('click', openPicker);
ui.chooseFile.addEventListener('click', openPicker);
ui.dropZone.addEventListener('click', (e) => { if (e.target === ui.dropZone || e.target.tagName === 'DIV') ui.fileInput.click(); });
ui.fileInput.addEventListener('change', () => loadFile(ui.fileInput.files[0]));
for (const ev of ['dragenter', 'dragover']) {
  ui.dropZone.addEventListener(ev, (e) => { e.preventDefault(); ui.dropZone.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  ui.dropZone.addEventListener(ev, (e) => { e.preventDefault(); ui.dropZone.classList.remove('over'); });
}
ui.dropZone.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) { setSource('file'); loadFile(e.dataTransfer.files[0]); }
});
for (const el of [ui.fromSec, ui.toSec]) el.addEventListener('change', scheduleReanalysis);

// Transport
ui.play.addEventListener('click', () => (playback.playing ? pausePlayback() : playFrom(playback.positionTick)));
ui.rewind.addEventListener('click', () => {
  const wasPlaying = playback.playing;
  stopPlayback();
  if (wasPlaying) playFrom(0);
});
ui.playhead.addEventListener('pointerdown', () => {
  playback.wasPlayingBeforeDrag = playback.playing;
  if (playback.playing) pausePlayback();
});
ui.playhead.addEventListener('input', () => seekTo(parseInt(ui.playhead.value, 10)));
ui.playhead.addEventListener('change', () => {
  seekTo(parseInt(ui.playhead.value, 10));
  if (playback.wasPlayingBeforeDrag) playFrom(playback.positionTick);
  playback.wasPlayingBeforeDrag = false;
});
ui.playhead.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); ui.play.click(); } });
ui.playSource.addEventListener('change', () => { if (playback.playing) playFrom(currentTick()); });
ui.trace.addEventListener('click', (e) => {
  if (!state.trace.length) return;
  const s = settings();
  const rect = ui.trace.getBoundingClientRect();
  const [t0, t1] = state.traceRange;
  const bt = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
  const scoreSec = bt - state.bufferAnchor - s.t0;
  const tick = clamp(secondsToTicks(Math.max(0, scoreSec), s), 0, playback.totalTicks);
  const wasPlaying = playback.playing;
  if (wasPlaying) pausePlayback();
  seekTo(tick);
  if (wasPlaying) playFrom(tick);
});

// Rhythm / notation settings
ui.tap.addEventListener('click', tapTempo);
for (const el of [ui.bpm, ui.timeSig, ui.swing, ui.grid, ui.key, ui.clef, ui.a4, ui.offsetBeats]) {
  el.addEventListener('change', refreshFromSettings);
}
ui.timeSig.addEventListener('change', () => showBeat(null, state.listening ? 'Free time' : 'Metronome off'));
ui.offsetMinus.addEventListener('click', () => { ui.offsetBeats.value = String(Math.max(0, (parseFloat(ui.offsetBeats.value) || 0) - 0.25)); refreshFromSettings(); });
ui.offsetPlus.addEventListener('click', () => { ui.offsetBeats.value = String(Math.min(12, (parseFloat(ui.offsetBeats.value) || 0) + 0.25)); refreshFromSettings(); });

// Microphone settings
ui.micDevice.addEventListener('change', async () => {
  if (!state.listening) return;
  try { await openStream(); setStatus('Switched microphone.'); }
  catch (err) { setStatus(`Could not open that microphone: ${err.message}`, true); }
});
ui.micProcessing.addEventListener('change', async () => {
  if (!state.listening) return;
  try { await openStream(); } catch (err) { setStatus(`Could not reopen microphone: ${err.message}`, true); }
});
ui.micGain.addEventListener('input', () => {
  updateSettingLabels();
  if (state.gainNode) state.gainNode.gain.value = settings().micGain;
});

// Detection settings: live update for the mic, debounced re-analysis for a loaded recording.
function onDetectionChange() {
  updateSettingLabels();
  applyDetectionSettings();
  if (state.audioBuffer && state.source !== 'mic') { drawTrace(); scheduleReanalysis(); }
}
ui.sensitivity.addEventListener('input', onDetectionChange);
ui.clarity.addEventListener('input', onDetectionChange);
ui.vibrato.addEventListener('input', onDetectionChange);
ui.method.addEventListener('change', () => {
  if (ui.method.value === 'whistle' && ui.rangePreset.value === 'full') {
    ui.rangePreset.value = 'whistle';
    ui.rangeLow.value = String(RANGE_PRESETS.whistle[0]);
    ui.rangeHigh.value = String(RANGE_PRESETS.whistle[1]);
  }
  onDetectionChange();
});
ui.rangePreset.addEventListener('change', () => {
  const preset = RANGE_PRESETS[ui.rangePreset.value];
  if (preset) {
    ui.rangeLow.value = String(preset[0]);
    ui.rangeHigh.value = String(preset[1]);
  }
  if (ui.rangePreset.value === 'whistle') {
    ui.method.value = 'whistle';
    if (parseInt(ui.clarity.value, 10) > 60) ui.clarity.value = '60';
    if (parseInt(ui.vibrato.value, 10) < 80) ui.vibrato.value = '80';
  }
  onDetectionChange();
});
for (const el of [ui.rangeLow, ui.rangeHigh]) {
  el.addEventListener('change', () => {
    const lo = ui.rangeLow.value, hi = ui.rangeHigh.value;
    const match = Object.entries(RANGE_PRESETS).find(([, [a, b]]) => String(a) === lo && String(b) === hi);
    ui.rangePreset.value = match ? match[0] : 'custom';
    onDetectionChange();
  });
}

navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
window.addEventListener('resize', () => { render(true); drawTrace(); });

// Debug hook: inject notes (score time, seconds) from the console, e.g.
// __earToStaff.load([{start:0,end:0.5,midi:60},{start:0.5,end:1,midi:62}])
window.__earToStaff = {
  state, playback, settings,
  render: () => render(true),
  load(notes) {
    stopPlayback();
    state.notes = notes.map((n) => ({ cents: 0, ...n }));
    setHasNotes(notes.length > 0);
    render(true);
  },
  async loadBuffer(buf, name = 'synthetic') { setAudioBuffer(buf, name); await runAnalysis(); },
};

updateSettingLabels();
refreshDevices();
showBeat(null, 'Metronome off');
setSource('file');
render(true);
