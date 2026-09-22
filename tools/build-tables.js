'use strict';
/* Builds the analysis tables (tables/*.csv, *.jsonl) for an extracted export, including exports
   made by versions before 0.5.0. Usage: node tools/build-tables.js path/to/replika-export */
const fs = require('node:fs');
const path = require('node:path');
const C = require('../extension/core.js');

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'raw'))) {
  console.error('Usage: node tools/build-tables.js path/to/replika-export (the folder containing raw/)');
  process.exit(1);
}
const jsonl = name => {
  const file = path.join(dir, 'raw', name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
};
const arrayOf = data => (Array.isArray(data) ? data : Object.values(data || {}).find(Array.isArray) || []);

// Same row linking as the exporter: media source_refs point inside a table row's source_ref.
const filesByRow = new Map();
for (const m of jsonl('media/collection.jsonl')) {
  if (!m.media_file_reference) continue;
  const row = (m.source_ref.match(/^[^#]+#(?:page=\d+|date=[\d-]+)\/index=\d+/) || [])[0];
  if (!row) continue;
  const list = filesByRow.get(row) || [];
  if (!list.includes(m.media_file_reference)) list.push(m.media_file_reference);
  filesByRow.set(row, list);
}
const filesFor = row => filesByRow.get(row.source_ref) || [];

const diaryPayloads = [...jsonl('diary/previews.jsonl'), ...jsonl('diary/details.jsonl')];
const tables = {
  chat_messages: C.chatMessages(jsonl('chat/pages.jsonl')).map(r => ({ ...r, media_file: filesFor(r)[0] ?? null })),
  diary_entries: C.diaryEntries(diaryPayloads.filter(x => x.kind === 'detail'), diaryPayloads.filter(x => x.kind === 'previews').flatMap(x => arrayOf(x.data)))
    .map(r => ({ ...r, media_files: filesFor(r).join(';') || null })),
  memories: C.memoryItems(jsonl('memories/pages.jsonl'))
};
fs.mkdirSync(path.join(dir, 'tables'), { recursive: true });
for (const [name, rows] of Object.entries(tables)) {
  fs.writeFileSync(path.join(dir, 'tables', `${name}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.writeFileSync(path.join(dir, 'tables', `${name}.csv`), C.csv(rows, C.TABLE_COLUMNS[name]));
  console.log(`tables/${name}: ${rows.length} rows`);
}
