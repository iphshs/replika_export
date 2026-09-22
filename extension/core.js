/* Shared, dependency-free data and export rules. No transport envelope enters this module. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplikaCore = api;
})(globalThis, function () {
  'use strict';
  const VERSION = '0.4.1', SCHEMA = 2;
  const SECRET = /(?:auth|token|cookie|session|secret|password|credential|api[_-]?key|timestamp[_-]?hash|authorization|headers?|signature|signed[_-]?url)/i;
  const URLISH = /https?:\/\//i;
  const MEDIA_HOSTS = new Set(['my.replika.com','d1gjmhogot71z7.cloudfront.net']);
  function allowedMedia(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && !u.username && !u.password && !u.port && MEDIA_HOSTS.has(u.hostname);
    } catch (_) { return false; }
  }
  function sanitize(value, stats = { secretFields: 0, urls: 0 }) {
    function walk(item) {
      if (Array.isArray(item)) return item.map(walk);
      if (typeof item === 'string') {
        if (URLISH.test(item)) { stats.urls++; return '[REDACTED_URL]'; }
        return item;
      }
      if (!item || typeof item !== 'object') return item;
      const out = {};
      for (const [key, child] of Object.entries(item)) {
        if (SECRET.test(key)) { out[key] = '[REDACTED]'; stats.secretFields++; }
        else out[key] = walk(child);
      }
      return out;
    }
    return walk(value);
  }
  function scanSecrets(value) {
    const result = { secretFields: 0, urlValues: 0 };
    function visit(item, key) {
      if (SECRET.test(key || '')) {
        if (item !== '[REDACTED]') result.secretFields++;
        return;
      }
      if (typeof item === 'string') { if (URLISH.test(item)) result.urlValues++; return; }
      if (Array.isArray(item)) item.forEach(x => visit(x, ''));
      else if (item && typeof item === 'object') Object.entries(item).forEach(([k,v]) => visit(v,k));
    }
    visit(value, '');
    return result;
  }
  function dateOf(record) { return record?.meta?.timestamp ?? record?.timestamp ?? record?.creation_timestamp ?? record?.date ?? null; }
  function validDate(v) { return typeof v === 'string' && !Number.isNaN(Date.parse(v)); }
  function diaryCursor(previews, until) {
    const dates=previews.map(x=>x?.date).filter(x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
    const earliest=dates[0]??null;
    return earliest&&earliest<until?earliest:null;
  }
  function coverage(source) {
    return { source, records: 0, pages: 0, earliest_retrieved: null, latest_retrieved: null,
      retrieval_started_at: new Date().toISOString(), retrieval_completed_at: null,
      termination: 'unavailable', complete_according_to_server_pagination: false,
      duplicate_ids: 0, overlapping_pages: 0, missing_ids: 0, missing_timestamps: 0,
      errors: [], warnings: [], exporter_version: VERSION, schema_version: SCHEMA };
  }
  function addRecords(c, records, seen, previous = new Set()) {
    let overlap = 0;
    for (const record of records) {
      const id = record?.id ?? record?.diary_entry_id ?? record?.diary_id ?? null;
      if (id == null) c.missing_ids++;
      else {
        const str = String(id);
        if (seen.has(str)) c.duplicate_ids++;
        if (previous.has(str)) overlap++;
        seen.add(str);
      }
      const date = dateOf(record);
      if (!validDate(date)) c.missing_timestamps++;
      else {
        if (!c.earliest_retrieved || Date.parse(date) < Date.parse(c.earliest_retrieved)) c.earliest_retrieved = date;
        if (!c.latest_retrieved || Date.parse(date) > Date.parse(c.latest_retrieved)) c.latest_retrieved = date;
      }
    }
    c.records += records.length;
    if (overlap) c.overlapping_pages++;
    return new Set(records.map(r => r?.id ?? r?.diary_entry_id ?? r?.diary_id).filter(x => x != null).map(String));
  }
  function finish(c, termination) {
    c.termination = termination;
    c.retrieval_completed_at = new Date().toISOString();
    c.complete_according_to_server_pagination = ['no_next_page','completed','empty'].includes(termination) && !c.errors.length && !c.duplicate_ids && !c.overlapping_pages;
    return c;
  }
  function manifest(selected, sources, redaction, media, policy = null) {
    return { exporter_version: VERSION, schema_version: SCHEMA, exported_at: new Date().toISOString(),
      browser: typeof navigator === 'object' ? 'Chrome extension' : 'synthetic test',
      sources_requested: selected, sources_retrieved: Object.values(sources).filter(x => x.pages > 0).map(x => x.source),
      warnings: Object.values(sources).flatMap(x => x.warnings.map(w => `${x.source}: ${w}`)),
      redaction_summary: redaction, media_included: media, collection_policy: policy,
      description: 'Retrieved participant-accessible data; not a claim of complete account history.' };
  }
  return { VERSION, SCHEMA, allowedMedia, sanitize, scanSecrets, dateOf, diaryCursor, coverage, addRecords, finish, manifest };
});
