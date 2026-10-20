# Ear to Staff

A browser app that turns a melody into standard music notation. It can listen to your microphone, analyze an audio file, or capture the audio of another browser tab. It was built to pull a whistled line out of a full-band recording, and it still works as a live transcriber for a solo voice or instrument. No build step, no server-side code, no accounts.

## Run it

Microphone and tab capture require `localhost` or HTTPS, so serve the folder rather than opening `index.html` directly:

```bash
python3 -m http.server 5173
```

Then open <http://localhost:5173>.

## Transcribing whistling from a record

1. Press **Open audio file…** (top left) and pick the track, or drop it on the box. No file? Pick **Browser tab audio**, play the song in another tab, and capture it. Nothing is written to disk.
2. Choose the **Whistle** pitch range. That switches the method to **Spectral peak** and relaxes clarity and vibrato tolerance.
3. Set **Analyze from / to** around the whistled passage so the first detected note is a whistled one.
4. Read the **pitch trace**. Teal dots are frames the detector accepted, grey are rejected, gold bars are the notes. If grey dots follow the melody, lower pitch clarity. If gold bars fragment, raise vibrato tolerance. Clarity, gate, and vibrato changes re-segment instantly; method and range changes re-run detection.
5. **Tap tempo** along with the record, choose **Light swing** or **Triplet swing**, and nudge **Bar 1 offset** until the bars fall where you hear them.
6. Play **Original** or **Both** in the transport to hear the record against the transcription. Click the trace to seek.
7. Export MusicXML or print.

### Where to get the audio file

- Own the CD? Import it with the Music app.
- Buy a DRM-free download from the iTunes Store, Amazon Music, Qobuz, or 7digital.
- Streaming only? Use **Browser tab audio**. Works in Chrome and Edge; Safari cannot share tab audio.
- Vinyl or tape? Record through an audio interface with QuickTime Player and drop the file in.

## How it works

| Stage | File | What it does |
| --- | --- | --- |
| Capture | `js/app.js` | Microphone via Web Audio, files via `decodeAudioData`, tab audio via `getDisplayMedia` + `MediaRecorder` decoded in memory |
| Pitch (solo) | `js/pitch.js` | McLeod Pitch Method autocorrelation with clarity score |
| Pitch (whistle) | `js/whistle.js`, `js/fft.js` | Spectral peaks ranked by lobe energy, a harmonic-series test that rejects overtones of lower notes (siblings at f ± f/h matched within 40 cents), narrowness and continuity scoring |
| Offline analysis | `js/analysis.js` | Frame detection, then a level prior relative to the loudest pitched material, then segmentation. The two stages are separate so re-segmenting is instant. |
| Segmentation | `js/segmenter.js` | Onset after ~45 ms of stable pitch, offset after ~80 ms of silence, new note only when pitch leaves the note's centre by more than the vibrato tolerance, re-trigger on level jumps |
| Theory | `js/theory.js` | Note spelling by key, Krumhansl-Schmuckler key detection |
| Notation | `js/notation.js` | Swing-aware quantization to an 8th or 16th grid, bar offset, rests, ties across barlines, VexFlow rendering |
| Export | `js/musicxml.js` | MusicXML 4.0 |

## Tests

```bash
node test/run.mjs
node test/whistle.mjs
```

The second file includes an end-to-end check that a synthetic record (guitar intro, whistled melody with vibrato, sung line) yields exactly the whistled notes.

## Limits

Monophonic lines only. The whistle tracker assumes the whistle is the loudest pure tone in its band, which is true of a featured whistle solo but not of a whistle buried under a brass section. If that is the situation, run a source separator such as Demucs on the file first and load the "other" stem.
