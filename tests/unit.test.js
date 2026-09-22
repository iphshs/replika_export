'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../extension/core.js');
const Z = require('../extension/zip.js');
const M = require('../extension/media.js');

test('secret keys are matched by segment, not substring', () => {
  for (const key of ['auth_token', 'x-auth-token', 'authorization', 'sessionId', 'client_token', 'password', 'api_key', 'apiKey', 'x-timestamp-hash', 'headers', 'signed_url', 'Cookie'])
    assert.equal(C.isSecretKey(key), true, key);
  for (const key of ['author', 'authored_at', 'text', 'timestamp', 'tokenizer_version', 'nature', 'date', 'keyword'])
    assert.equal(C.isSecretKey(key), false, key);
});

test('sanitize redacts URLs inside text but keeps the rest of the message', () => {
  const stats = { secretFields: 0, urls: 0 };
  const out = C.sanitize({ content: { text: 'look https://a.example/x?sig=1 and http://b.example ok' }, meta: { auth_token: 'S' }, author: 'me' }, stats);
  assert.equal(out.content.text, 'look [REDACTED_URL] and [REDACTED_URL] ok');
  assert.equal(out.meta.auth_token, '[REDACTED]');
  assert.equal(out.author, 'me');
  assert.deepEqual(stats, { secretFields: 1, urls: 2 });
  assert.deepEqual(C.scanSecrets(out), { secretFields: 0, urlValues: 0 });
});

test('sanitize keeps a literal __proto__ key as data', () => {
  const out = C.sanitize(JSON.parse('{"__proto__":{"x":1},"a":2}'));
  assert.deepEqual(Object.keys(out), ['__proto__', 'a']);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test('addRecords reports fresh records and tolerates an inclusive page boundary', () => {
  const c = C.coverage('chat'), seen = new Set();
  const p1 = [{ id: 3, meta: { timestamp: '2024-01-03T00:00:00Z' } }, { id: 2, meta: { timestamp: '2024-01-02T00:00:00Z' } }];
  const p2 = [{ id: 2, meta: { timestamp: '2024-01-02T00:00:00Z' } }, { id: 1, meta: { timestamp: '2024-01-01T00:00:00Z' } }];
  assert.equal(C.addRecords(c, p1, seen), 2);
  assert.equal(C.addRecords(c, p2, seen, C.pageIds(p1)), 1);
  assert.equal(c.unique_records, 3);
  assert.equal(c.overlapping_pages, 1);
  assert.equal(c.earliest_retrieved, '2024-01-01T00:00:00Z');
  C.finish(c, 'no_next_page');
  assert.equal(c.complete_according_to_server_pagination, true);
});

test('warn de-duplicates and the manifest reports counts', () => {
  const c = C.coverage('diary');
  C.warn(c, 'x'); C.warn(c, 'x'); C.warn(c, 'y');
  assert.deepEqual(c.warnings, ['x', 'y']);
  assert.deepEqual(C.manifest(['diary'], { diary: c }, {}, {}).warnings, ['diary: x (×2)', 'diary: y']);
});

test('chatMessages flattens, de-duplicates and orders pages', () => {
  const rows = C.chatMessages([
    { page: 1, data: { messages: [
      { id: 'b', content: { type: 'text', text: 'hi 👋' }, meta: { nature: 'Robot', timestamp: '2024-01-02T00:00:00Z' } },
      { id: 'c', content: { type: 'voice_message' }, meta: { nature: 'Customer', timestamp: '2024-01-03T00:00:00Z' } }] } },
    { page: 2, data: { messages: [
      { id: 'a', content: { type: 'text', text: 'first' }, meta: { nature: 'Customer', timestamp: '2024-01-01T00:00:00Z' } },
      { id: 'b', content: { type: 'text', text: 'hi 👋' }, meta: { nature: 'Robot', timestamp: '2024-01-02T00:00:00Z' } }] } }
  ]);
  assert.deepEqual(rows.map(r => [r.sequence, r.message_id, r.sender]), [[1, 'a', 'user'], [2, 'b', 'replika'], [3, 'c', 'user']]);
  assert.equal(rows[1].source_ref, 'raw/chat/pages.jsonl#page=1/index=0');
  assert.equal(rows[2].is_voice, true);
});

test('diaryEntries and memoryItems produce one row per item', () => {
  const d = C.diaryEntries([{ date: '2024-02-01', data: { entries: [{ id: 9, name: 'Title', text: 'Body', image_count: 1 }] } }]);
  assert.equal(d.length, 1);
  assert.equal(d[0].title, 'Title');
  const m = C.memoryItems([{ kind: 'memory_v3', data: { facts: [{ id: 1, text: 'likes tea', category_id: 'c' }], persons: [{ id: 2, name: 'Sam' }] } }]);
  assert.deepEqual(m.map(r => [r.group, r.text]), [['facts', 'likes tea'], ['persons', 'Sam']]);
});

test('csv escapes quotes, commas and newlines', () => {
  const out = C.csv([{ a: 'x,"y"\nz', b: null, c: true }], ['a', 'b', 'c']);
  assert.equal(out, '﻿a,b,c\r\n"x,""y""\nz",,true\r\n');
});

test('ZIP output is valid and carries a real timestamp', () => {
  const blobToFile = async blob => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zip-')), 'out.zip');
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    return file;
  };
  return blobToFile(Z.build([['replika-export/a.txt', 'héllo 👋'], ['replika-export/m/b.bin', new Uint8Array([1, 2, 3])]], new Date(2024, 4, 6, 7, 8, 10))).then(file => {
    const report = execFileSync('python3', ['-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
for i in z.infolist(): print(i.filename, i.date_time, z.read(i).decode('utf-8','replace'))`, file]).toString();
    assert.match(report, /replika-export\/a\.txt \(2024, 5, 6, 7, 8, 10\) héllo 👋/);
    assert.match(report, /replika-export\/m\/b\.bin/);
  });
});

test('ZIP rejects unsafe paths', () => {
  assert.throws(() => Z.build([['replika-export/../x', 'a']]), /Invalid ZIP path/);
  assert.throws(() => Z.build([['other/x', 'a']]), /Invalid ZIP path/);
});

const fakeResponse = (bytes, type, status = 200) => ({
  ok: status < 400, status, redirected: false,
  headers: new Map([['content-type', type]]),
  body: null, arrayBuffer: async () => new Uint8Array(bytes).buffer
});

test('media retrieval sniffs the real format', async () => {
  const mp3 = [0x49, 0x44, 0x33, 4, 0, 0];
  const got = await M.retrieve('https://d1gjmhogot71z7.cloudfront.net/a', 'voice', async () => fakeResponse(mp3, 'application/octet-stream'));
  assert.equal(got.extension, 'mp3');
  assert.equal(M.extension(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/jpeg'), 'png');
  assert.equal(M.extension(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41]), ''), 'm4a');
  assert.equal(M.extension(new Uint8Array([0xff, 0xf1, 0x50]), ''), 'aac');
});

test('media retrieval enforces host, type and status rules', async () => {
  await assert.rejects(M.retrieve('https://evil.example/a', 'voice', async () => fakeResponse([1], 'audio/mpeg')), /media_host_not_allowlisted/);
  await assert.rejects(M.retrieve('https://my.replika.com/a', 'diary_images', async () => fakeResponse([1], 'text/html')), /unexpected_content_type/);
  await assert.rejects(M.retrieve('https://my.replika.com/a', 'voice', async () => fakeResponse([1], 'audio/mpeg', 429)), /rate_limited/);
  await assert.rejects(M.retrieve('https://my.replika.com/a', 'voice', async () => fakeResponse([], 'audio/mpeg')), /empty_file/);
});

test('generic binary media is accepted only when the bytes match the expected kind', async () => {
  const png = [0x89, 0x50, 0x4e, 0x47, 13, 10];
  assert.equal((await M.retrieve('https://my.replika.com/i', 'diary_images', async () => fakeResponse(png, 'application/octet-stream'))).extension, 'png');
  await assert.rejects(M.retrieve('https://my.replika.com/i', 'voice', async () => fakeResponse(png, 'application/octet-stream')), /unexpected_content_type/);
  await assert.rejects(M.retrieve('https://my.replika.com/i', 'voice', async () => fakeResponse([1, 2, 3], '')), /unexpected_content_type/);
});
