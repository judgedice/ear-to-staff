# Transcription history

One JSON file per take, written by the app's **Download JSON** or **Save to GitHub** buttons. `index.json` lists them for the app's History panel and is rebuilt automatically by a GitHub Action whenever files here change. To add a take by hand, drop its JSON file in this folder and push; the index updates on its own.

Records contain the detected notes, the settings that shape the score, and the MusicXML. They never contain audio.
