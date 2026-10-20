#!/usr/bin/env node
/**
 * Rebuild transcriptions/index.json from the record files in transcriptions/.
 * Run by the GitHub Action on push, or by hand after committing files manually.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryFor, validateRecord, mergeIndex, TRANSCRIPTIONS_DIR, INDEX_FILE } from '../js/history.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, TRANSCRIPTIONS_DIR);
const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();

let index = [];
for (const f of files) {
  try {
    const record = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    const problem = validateRecord(record);
    if (problem) { console.warn(`skip ${f}: ${problem}`); continue; }
    index = mergeIndex(index, entryFor(record, f));
  } catch (err) {
    console.warn(`skip ${f}: ${err.message}`);
  }
}

const out = JSON.stringify(index, null, 2) + '\n';
const target = path.join(root, INDEX_FILE);
let previous = '';
try { previous = await readFile(target, 'utf8'); } catch (_) { /* first run */ }
if (previous === out) {
  console.log(`index unchanged (${index.length} entries)`);
} else {
  await writeFile(target, out);
  console.log(`wrote ${INDEX_FILE} with ${index.length} entries`);
}
