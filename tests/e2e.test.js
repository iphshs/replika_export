'use strict';
/* Loads the real extension in Chromium against a mocked my.replika.com (HTTP API + chat WebSocket)
   and checks the downloaded ZIP. Run with: npm run test:e2e (needs Playwright and Chromium). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch (_) { try { ({ chromium } = require(path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright'))); } catch (_) {} }

const EXT = path.resolve(__dirname, '../extension');
const SECRET = 'SECRET-AUTH-VALUE';
const VOICE_URL = 'https://d1gjmhogot71z7.cloudfront.net/voice/1.mp3';
const IMAGE_URL = 'https://d1gjmhogot71z7.cloudfront.net/diary/1.png';
const TOTAL = 250;

// Newest message has the highest number. Timestamps one minute apart.
const messages = Array.from({ length: TOTAL }, (_, i) => ({
  id: `m${String(i).padStart(4, '0')}`,
  content: i === 7 ? { type: 'voice_message', voice_message_url: VOICE_URL } :
    { type: 'text', text: i === 3 ? 'see https://example.com/x?sig=abc, then reply 👋' : `message ${i}` },
  meta: { nature: i % 2 ? 'Robot' : 'Customer', timestamp: new Date(Date.UTC(2023, 0, 1, 0, i)).toISOString(), client_token: 'ct', ...(i === 7 ? { voice_message_url: VOICE_URL } : {}) }
}));
// Replika's cursor semantics are unconfirmed, so the mock is run with inclusive and exclusive cursors.
let inclusive = true;
function historyPage(cursor, limit) {
  const end = cursor == null ? TOTAL : messages.findIndex(m => m.id === cursor) + (inclusive ? 1 : 0);
  return messages.slice(Math.max(0, end - limit), end);
}
const previews = [
  { id: 'd3', date: '2024-03-03', read: true, name: 'Third' },
  { id: 'd2', date: '2024-03-02', read: true, name: 'Second' },
  { id: 'd1', date: '2024-03-01', read: false, name: 'Unread' }
];
let diaryDetailFailures = 1, readUnread = false;
const api = {
  'diaries/count': () => ({ count: 3 }),
  'profile': () => ({ id: 'u1', name: 'Tester', registration_date: '2022-05-01', auth_token: SECRET, author: 'kept' }),
  'personal_bot': () => ({ id: 'b1', name: 'Rep' }),
  'personal_bot_chat': () => ({ id: 'c1' }),
  'relationship_statuses': () => [{ id: 'friend' }],
  'core_description': () => ({ text: 'core' }),
  'memory/v3/': () => ({ facts: [{ id: 'f1', text: 'likes tea', category_id: 'likes', creation_timestamp: '2023-06-01T00:00:00Z' }], persons: [{ id: 'p1', name: 'Sam', relation: 'friend' }] }),
  'memory/v3/unstructured_fact_categories': () => [{ id: 'likes', name: 'Likes' }],
  'memory/relations': () => [{ id: 'friend', name: 'Friend' }]
};

const page = `<!doctype html><html><body>
<nav><a href="/">Chat</a> <a href="/diary">Diary</a></nav><div id="app">Mock Replika</div>
<script>
  const headers = { 'x-auth-token': '${SECRET}', 'x-user-id': 'u1', 'x-device-id': 'dev', 'content-type': 'application/json' };
  const ws = new WebSocket('wss://ws.replika.com/v17');
  ws.onopen = () => ws.send(JSON.stringify({ event_name: 'history', token: 'app', auth: { user_id: 'u1', auth_token: '${SECRET}', device_id: 'dev' }, payload: { chat_id: 'c1', limit: 20 } }));
  document.querySelector('a[href="/diary"]').addEventListener('click', e => { e.preventDefault(); fetch('/api/mobile/1.5/personal_bot', { headers }); });
  document.querySelector('a[href="/"]').addEventListener('click', e => e.preventDefault());
  setTimeout(() => fetch('/api/mobile/1.5/profile', { method: 'POST', headers, body: '{}' }), 300);
</script></body></html>`;

for (const mode of ['inclusive', 'exclusive']) test(`end-to-end export against a mocked Replika (${mode} cursors)`, { skip: !chromium && 'Playwright not installed', timeout: 180000 }, async () => {
  inclusive = mode === 'inclusive'; diaryDetailFailures = 1; readUnread = false;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replika-e2e-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  try {
    const sawPostHeaders = [];
    await context.route('https://my.replika.com/**', async route => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/mobile/1.5/')) return route.fulfill({ contentType: 'text/html', body: page });
      const key = url.pathname.slice('/api/mobile/1.5/'.length);
      if (route.request().method() === 'GET') sawPostHeaders.push(route.request().headers()['content-type'] ?? null);
      if (route.request().headers()['x-auth-token'] !== SECRET) return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
      if (key === 'diaries') {
        const until = url.searchParams.get('until');
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(previews.filter(p => inclusive ? p.date <= until : p.date < until)) });
      }
      const day = key.match(/^diaries\/(\d{4}-\d{2}-\d{2})$/)?.[1];
      if (day) {
        if (day === '2024-03-01') readUnread = true;
        if (day === '2024-03-02' && diaryDetailFailures-- > 0) return route.fulfill({ status: 503, body: '' });
        const entries = [{ id: `e-${day}`, name: `Entry ${day}`, text: `Body ${day}`, image_count: day === '2024-03-03' ? 1 : 0, ...(day === '2024-03-03' ? { image_url: IMAGE_URL } : {}) }];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ date: day, entries }) });
      }
      if (api[key]) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(api[key]()) });
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await context.route('https://d1gjmhogot71z7.cloudfront.net/**', route => {
      const png = route.request().url().endsWith('.png');
      return route.fulfill({ contentType: 'application/octet-stream', body: png ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]) : Buffer.from('ID3\x04\x00\x00fake-mp3') });
    });
    const requestedLimits = [];
    await context.routeWebSocket('wss://ws.replika.com/**', ws => {
      ws.onMessage(raw => {
        const frame = JSON.parse(raw);
        if (frame.event_name !== 'history') return;
        requestedLimits.push(frame.payload.limit);
        const page = historyPage(frame.payload.last_message_id ?? null, Math.min(frame.payload.limit, 100));
        ws.send(JSON.stringify({ event_name: 'history', token: frame.token, payload: { messages: page } }));
      });
    });

    const replika = await context.newPage();
    await replika.goto('https://my.replika.com/');
    await replika.waitForTimeout(800);

    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    const extId = new URL(worker.url()).host;
    const exporter = await context.newPage();
    await exporter.goto(`chrome-extension://${extId}/exporter.html`);
    await exporter.waitForFunction(() => document.getElementById('connection').textContent === 'Connected to Replika');
    await exporter.evaluate(() => {
      chrome.downloads.download = async options => {
        const bytes = new Uint8Array(await (await fetch(options.url)).arrayBuffer());
        window.__zip = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
        return 1;
      };
    });
    await exporter.click('#create');
    await exporter.waitForSelector('#ready:not([hidden])', { timeout: 150000 });
    await exporter.click('#download');
    await exporter.waitForFunction(() => window.__zip);
    const zipPath = path.join(profileDir, 'export.zip');
    fs.writeFileSync(zipPath, Buffer.from(await exporter.evaluate(() => window.__zip), 'base64'));

    const listing = JSON.parse(execFileSync('python3', ['-c', `import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({i.filename: z.read(i).decode('latin-1') for i in z.infolist()}))`, zipPath], { maxBuffer: 1 << 26 }).toString());
    const read = name => Buffer.from(listing[`replika-export/${name}`], 'latin1').toString('utf8');
    const all = Object.values(listing).join('\n');

    assert.ok(!all.includes(SECRET), 'auth secret must never reach the export');
    assert.ok(!all.includes('cloudfront.net'), 'signed media URLs must not reach the export');
    assert.ok(requestedLimits.includes(100), 'chat pages use the larger page size');
    assert.ok(sawPostHeaders.every(x => x === null), 'content-type from the app POST must not be replayed on GETs');
    assert.equal(readUnread, false, 'unread diary detail must not be opened');

    const summary = JSON.parse(read('export_summary.json'));
    assert.equal(summary.sources.chat.unique_records, TOTAL);
    assert.ok(['no_next_page', 'empty'].includes(summary.sources.chat.termination));
    assert.equal(summary.sources.chat.complete_according_to_server_pagination, true);
    assert.equal(summary.sources.diary.termination, 'no_next_page');
    assert.equal(summary.sources.diary.details_retrieved, 2);
    assert.equal(summary.sources.diary.unread_details_skipped, 1);
    assert.ok(summary.sources.diary.retries >= 1, 'transient 503 was retried');
    assert.equal(summary.media.voice.collected, 2, 'both references to the voice file are linked');

    const chat = read('tables/chat_messages.jsonl').trim().split('\n').map(JSON.parse);
    assert.equal(chat.length, TOTAL);
    assert.deepEqual(chat.map(r => r.message_id), messages.map(m => m.id), 'chronological and de-duplicated');
    assert.equal(chat[3].text, 'see [REDACTED_URL] then reply 👋');
    assert.equal(chat[0].sender, 'user');
    assert.equal(chat[7].media_file, 'media/voice/0001.mp3');
    assert.ok(listing['replika-export/media/voice/0001.mp3'].startsWith('ID3'));
    assert.ok(!listing['replika-export/media/voice/0002.mp3'], 'duplicate voice reference is not downloaded twice');
    assert.ok(listing['replika-export/media/diary-images/0001.png']);
    assert.equal(read('tables/chat_messages.csv').split('\r\n').length, TOTAL + 2);

    const diary = read('tables/diary_entries.jsonl').trim().split('\n').map(JSON.parse);
    assert.deepEqual(diary.map(r => r.diary_date), ['2024-03-02', '2024-03-03']);
    assert.equal(diary[1].media_files, 'media/diary-images/0001.png');
    assert.equal(read('tables/memories.jsonl').trim().split('\n').length, 4);

    const profile = JSON.parse(read('raw/profile/profile.json'));
    assert.equal(profile.auth_token, '[REDACTED]');
    assert.equal(profile.author, 'kept');
    assert.match(read('README.txt'), /chat_messages +250 rows/);
  } finally { await context.close(); }
});
