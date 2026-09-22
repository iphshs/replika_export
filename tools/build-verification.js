'use strict';
/* Regenerates BUILD-VERIFICATION.json from the files actually in extension/. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const files = Object.fromEntries(fs.readdirSync(dir).sort().map(name =>
  [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
const out = {
  version: manifest.version,
  generated_at: new Date().toISOString(),
  files,
  checks: ['npm test: unit tests (core, zip, media)', 'npm run test:e2e: extension in Chromium against a mocked Replika, inclusive and exclusive cursors'],
  browser_validation: 'Mocked end-to-end only; not yet run against the live Replika service',
  submission: 'Disabled; local collection and download only'
};
fs.writeFileSync(path.join(root, 'BUILD-VERIFICATION.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`BUILD-VERIFICATION.json written for ${manifest.version} (${Object.keys(files).length} files)`);
