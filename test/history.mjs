import assert from 'node:assert/strict';
import { buildRecord, validateRecord, slugFor, entryFor, mergeIndex, repoFromLocation, GitHubSaver, INDEX_FILE } from '../js/history.js';

let passed = 0;
function test(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log('ok  ', name); }, (e) => { console.error('FAIL', name, '\n   ', e.message); process.exitCode = 1; }); }

const notes = [{ start: 0, end: 0.5, midi: 81, cents: 3 }, { start: 0.5, end: 1.0, midi: 83, cents: -2 }];
const settings = { bpm: 92, timeSig: '4/4', key: 'auto', method: 'whistle' };
const record = buildRecord({ title: 'Lazy Bones – whistle solo', source: 'lazybones.m4a', settings, notes, musicxml: '<score-partwise/>', bars: 4 });

await test('buildRecord produces a valid record', () => {
  assert.equal(validateRecord(record), null);
  assert.equal(record.version, 1);
  assert.equal(record.notes.length, 2);
  assert.ok(!Number.isNaN(Date.parse(record.createdAt)));
});

await test('validateRecord rejects junk', () => {
  assert.ok(validateRecord(null));
  assert.ok(validateRecord({ version: 1 }));
  assert.ok(validateRecord({ ...record, notes: [{ start: 'x' }] }));
});

await test('slugFor is date-prefixed, filesystem safe, .json', () => {
  const slug = slugFor({ ...record, createdAt: '2026-10-20T14:05:00.000Z' });
  assert.match(slug, /^2026-10-20-\d{4}-lazy-bones-whistle-solo\.json$/);
  assert.ok(!/[^a-z0-9.-]/.test(slug));
});

await test('entryFor + mergeIndex round trip (replace same file, newest first)', () => {
  const a = entryFor({ ...record, createdAt: '2026-10-01T00:00:00Z' }, 'a.json');
  const b = entryFor({ ...record, title: 'Second', createdAt: '2026-10-02T00:00:00Z' }, 'b.json');
  let idx = mergeIndex([], a);
  idx = mergeIndex(idx, b);
  assert.deepEqual(idx.map((e) => e.file), ['b.json', 'a.json']);
  idx = mergeIndex(idx, { ...a, title: 'Renamed' });
  assert.equal(idx.length, 2);
  assert.equal(idx.find((e) => e.file === 'a.json').title, 'Renamed');
  assert.equal(a.noteCount, 2);
  assert.equal(a.bpm, 92);
});

await test('repoFromLocation reads owner/repo from a Pages URL', () => {
  assert.equal(repoFromLocation({ hostname: 'judgedice.github.io', pathname: '/ear-to-staff/' }), 'judgedice/ear-to-staff');
  assert.equal(repoFromLocation({ hostname: 'localhost', pathname: '/' }), null);
});

await test('GitHubSaver.saveRecord: PUT record, GET index, PUT merged index', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.split('?')[0];
    calls.push({ url: path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (!init.method && !path.endsWith('index.json')) return new Response('{}', { status: 404 });
    if (init.method === 'PUT' && path.includes('/transcriptions/') && !path.endsWith('index.json')) {
      return new Response(JSON.stringify({ content: { html_url: 'https://github.com/o/r/blob/main/x.json' } }), { status: 201 });
    }
    if (!init.method && path.endsWith('index.json')) {
      const existing = Buffer.from(JSON.stringify([{ file: 'old.json', title: 'Old' }])).toString('base64');
      return new Response(JSON.stringify({ sha: 'abc123', content: existing, encoding: 'base64' }), { status: 200 });
    }
    if (init.method === 'PUT' && path.endsWith('index.json')) {
      return new Response(JSON.stringify({ content: {} }), { status: 200 });
    }
    return new Response('nope', { status: 500 });
  };
  const saver = new GitHubSaver({ repo: 'o/r', token: 'tok', fetchImpl });
  const { file, url } = await saver.saveRecord(record);
  assert.equal(file, slugFor(record));
  assert.equal(url, 'https://github.com/o/r/blob/main/x.json');
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PUT', 'GET', 'PUT']);
  assert.ok(calls[1].url.startsWith('https://api.github.com/repos/o/r/contents/transcriptions/'));
  assert.equal(calls[1].headers.Authorization, 'Bearer tok');
  assert.equal(calls[1].body.sha, undefined, 'new file: no sha');
  assert.deepEqual(JSON.parse(Buffer.from(calls[1].body.content, 'base64').toString('utf8')).title, record.title);
  assert.ok(calls[2].url.endsWith(`/contents/${INDEX_FILE}`));
  assert.equal(calls[3].body.sha, 'abc123');
  const merged = JSON.parse(Buffer.from(calls[3].body.content, 'base64').toString('utf8'));
  assert.deepEqual(merged.map((e) => e.file), [file, 'old.json']);
  for (const c of calls) assert.ok(c.url.startsWith('https://api.github.com/'), 'token only goes to api.github.com');
});

await test('GitHubSaver surfaces a friendly 401', async () => {
  const saver = new GitHubSaver({ repo: 'o/r', token: 'bad', fetchImpl: async () => new Response('{}', { status: 401 }) });
  await assert.rejects(() => saver.saveRecord(record), /token/i);
});

console.log(`\n${passed} history checks passed`);
