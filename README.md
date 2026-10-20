# Ear to Staff

A browser app that turns a melody into standard music notation. It can listen to your microphone, analyze an audio file, or capture the audio of another browser tab. It was built to pull a whistled line out of a full-band recording, and it still works as a live transcriber for a solo voice or instrument. No build step, no server-side code, no accounts.

## Try it

**Live app:** <https://judgedice.github.io/ear-to-staff/>

No install needed. Microphone and tab capture work there because GitHub Pages serves over HTTPS.

## Run it locally

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

## History

Every take you want to keep can be saved as a small JSON record in [`transcriptions/`](transcriptions/). A record holds the title, the source file name, when it was made, every setting that shaped the score, the detected notes (start, end, MIDI, cents), and the exported MusicXML. Audio is never stored, so the public repository never contains the recording.

The **History** panel in the app lists the saved takes from `transcriptions/index.json`. Click one to restore its notes and settings. Dropping a record's `.json` file onto the app does the same.

Two ways to save:

- **Download JSON** saves the record to your computer. Commit it into `transcriptions/` and push.
- **Save to GitHub** commits it straight from the browser through the GitHub Contents API. Open **GitHub settings** in the panel and paste a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) that is limited to this repository with **Contents: Read and write**. The token stays in your browser's local storage and is only ever sent to `api.github.com`. Use **Forget token** to remove it.

A GitHub Action rebuilds `transcriptions/index.json` whenever a record is pushed, so hand-committed files show up too. The same script runs locally:

```bash
node scripts/build-index.mjs
```

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
| History | `js/history.js`, `scripts/build-index.mjs` | Record format, index merging, GitHub Contents API client; Action keeps the index current |

## Tests

```bash
node test/run.mjs
node test/whistle.mjs
node test/history.mjs
```

The second file includes an end-to-end check that a synthetic record (guitar intro, whistled melody with vibrato, sung line) yields exactly the whistled notes.

## Limits

Monophonic lines only. The whistle tracker assumes the whistle is the loudest pure tone in its band, which is true of a featured whistle solo but not of a whistle buried under a brass section. If that is the situation, run a source separator such as Demucs on the file first and load the "other" stem.
