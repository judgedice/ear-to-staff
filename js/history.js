/**
 * Transcription history: one JSON record per take, stored in the repo under
 * transcriptions/, plus transcriptions/index.json listing them. Records hold
 * the notes in score time and every setting that shapes the score, so a take
 * can be reloaded and re-quantized later. Audio is never stored.
 *
 * Pure functions here are shared by the app and scripts/build-index.mjs.
 */
export const HISTORY_VERSION = 1;
export const TRANSCRIPTIONS_DIR = 'transcriptions';
export const INDEX_FILE = `${TRANSCRIPTIONS_DIR}/index.json`;

/** Build a record from the app's current state. */
export function buildRecord({ title, source, settings, notes, musicxml, bars }) {
  return {
    version: HISTORY_VERSION,
    title: (title || '').trim() || 'Untitled take',
    source: source || '',
    createdAt: new Date().toISOString(),
    bars: bars ?? 0,
    settings,
    notes: notes.map((n) => ({
      start: round(n.start, 4),
      end: round(n.end, 4),
      midi: n.midi,
      cents: n.cents ?? 0,
    })),
    musicxml: musicxml || '',
  };
}

/** Basic shape check for a loaded record. Returns a problem string or null. */
export function validateRecord(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  if (!Array.isArray(r.notes)) return 'missing notes';
  if (!r.settings || typeof r.settings !== 'object') return 'missing settings';
  for (const n of r.notes) {
    if (!Number.isFinite(n.start) || !Number.isFinite(n.end) || !Number.isInteger(n.midi)) return 'bad note';
  }
  return null;
}

/** File name for a record: 2026-10-20-1412-lazy-bones-whistle.json */
export function slugFor(record) {
  const d = new Date(record.createdAt);
  const pad = (v) => String(v).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug = record.title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'take';
  return `${stamp}-${slug}.json`;
}

/** Index entry: enough to list a take without fetching the whole record. */
export function entryFor(record, file) {
  return {
    file,
    title: record.title,
    source: record.source,
    createdAt: record.createdAt,
    bars: record.bars ?? 0,
    noteCount: record.notes.length,
    bpm: record.settings?.bpm ?? null,
    timeSig: record.settings?.timeSig ?? null,
    key: record.settings?.key ?? null,
  };
}

/** Insert or replace an entry, newest first. */
export function mergeIndex(index, entry) {
  const list = Array.isArray(index) ? index.filter((e) => e.file !== entry.file) : [];
  list.push(entry);
  list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return list;
}

/** Guess owner/repo from a GitHub Pages URL like https://owner.github.io/repo/. */
export function repoFromLocation(loc = globalThis.location) {
  if (!loc) return null;
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(loc.hostname);
  if (!m) return null;
  const seg = loc.pathname.split('/').filter(Boolean)[0];
  return seg ? `${m[1]}/${seg}` : null;
}

function round(v, places) {
  const f = Math.pow(10, places);
  return Math.round(v * f) / f;
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64Utf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Minimal GitHub Contents API client. Commits a record file and updates the
 * index with two or three requests. The token never goes anywhere but
 * api.github.com.
 */
export class GitHubSaver {
  constructor({ repo, token, branch = 'main', fetchImpl = globalThis.fetch.bind(globalThis) }) {
    const [owner, name] = String(repo || '').split('/');
    if (!owner || !name) throw new Error('Repository must look like owner/repo');
    if (!token) throw new Error('A GitHub token is required');
    this.owner = owner;
    this.repo = name;
    this.token = token;
    this.branch = branch;
    this.fetch = fetchImpl;
  }

  _url(path) {
    return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;
  }

  _headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  /** Returns { sha, text } or null when the file does not exist. */
  async getFile(path) {
    const res = await this.fetch(`${this._url(path)}?ref=${encodeURIComponent(this.branch)}`, { headers: this._headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await this._error(res));
    const body = await res.json();
    return { sha: body.sha, text: fromBase64Utf8(body.content || '') };
  }

  async putFile(path, text, message, sha) {
    const payload = { message, content: toBase64Utf8(text), branch: this.branch };
    if (sha) payload.sha = sha;
    const res = await this.fetch(this._url(path), {
      method: 'PUT',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await this._error(res));
    return res.json();
  }

  /** Commit the record and refresh the index. Returns { file, url }. */
  async saveRecord(record) {
    const file = slugFor(record);
    const path = `${TRANSCRIPTIONS_DIR}/${file}`;
    const existing = await this.getFile(path);
    const put = await this.putFile(path, JSON.stringify(record, null, 2) + '\n', `Add transcription: ${record.title}`, existing?.sha);

    const idx = await this.getFile(INDEX_FILE);
    let list = [];
    if (idx) { try { list = JSON.parse(idx.text); } catch (_) { list = []; } }
    const merged = mergeIndex(list, entryFor(record, file));
    await this.putFile(INDEX_FILE, JSON.stringify(merged, null, 2) + '\n', `Index transcription: ${record.title}`, idx?.sha);

    return { file, url: put?.content?.html_url || `https://github.com/${this.owner}/${this.repo}/blob/${this.branch}/${path}` };
  }

  async _error(res) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (_) { /* ignore */ }
    if (res.status === 401) return 'GitHub rejected the token (401). Check it has not expired.';
    if (res.status === 403) return `GitHub refused (403): ${detail || 'token lacks Contents write access to this repository'}`;
    if (res.status === 404) return 'Repository not found, or the token cannot see it (404).';
    if (res.status === 409) return 'Conflict (409): the file changed on GitHub. Try again.';
    return `GitHub error ${res.status}${detail ? `: ${detail}` : ''}`;
  }
}
