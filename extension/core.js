/* Shared, dependency-free data and export rules. No transport envelope enters this module. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplikaCore = api;
})(globalThis, function () {
  'use strict';
  const VERSION = '0.5.0', SCHEMA = 3;
  // Matched against whole key segments (snake_case, kebab-case and camelCase are split first),
  // so `author` or `authored_at` are kept while `auth_token`, `x-auth-token` or `sessionId` are not.
  const SECRET_SEGMENT = /^(?:auth|token|tokens|cookie|cookies|secret|secrets|password|passwd|credential|credentials|signature|headers?|apikey)$/;
  // `session` alone is ambiguous: Replika uses it for statistics (all_day_session_last_updated, ar_sessions_count).
  // Email addresses are personal identifiers, so fields holding one (e.g. profile.email_settings.email)
  // are removed too; flags such as is_email_verified are kept.
  const SECRET_JOINED = /(?:api_?key|timestamp_?hash|authoriz|authenticat|signed_?url|access_?key|private_?key|^session$|session_?(?:id|key|token|secret)$|(?:^|_)e_?mail(?:_address)?$)/;
  const URLISH = /https?:\/\//i;
  const URL_ANYWHERE = /https?:\/\/[^\s"'<>]*/gi;
  const MEDIA_HOSTS = new Set(['my.replika.com','d1gjmhogot71z7.cloudfront.net']);
  function isSecretKey(key) {
    const flat = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (SECRET_JOINED.test(flat.replace(/-/g, '_'))) return true;
    return flat.split(/[^a-z0-9]+/).some(part => SECRET_SEGMENT.test(part));
  }
  function allowedMedia(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && !u.username && !u.password && !u.port && MEDIA_HOSTS.has(u.hostname);
    } catch (_) { return false; }
  }
  // URLs are replaced where they occur, so surrounding message text survives for analysis.
  function sanitize(value, stats = { secretFields: 0, urls: 0 }) {
    function walk(item) {
      if (Array.isArray(item)) return item.map(walk);
      if (typeof item === 'string') {
        if (!URLISH.test(item)) return item;
        return item.replace(URL_ANYWHERE, () => { stats.urls++; return '[REDACTED_URL]'; });
      }
      if (!item || typeof item !== 'object') return item;
      const out = {};
      for (const [key, child] of Object.entries(item)) {
        const safe = isSecretKey(key) ? (stats.secretFields++, '[REDACTED]') : walk(child);
        Object.defineProperty(out, key, { value: safe, enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return walk(value);
  }
  function scanSecrets(value) {
    const result = { secretFields: 0, urlValues: 0 };
    function visit(item, key) {
      if (isSecretKey(key)) {
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
  const isDay = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  const idOf = record => record?.id ?? record?.diary_entry_id ?? record?.diary_id ?? null;
  function diaryCursor(previews, until) {
    const dates=previews.map(x=>x?.date).filter(x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)).sort();
    const earliest=dates[0]??null;
    return earliest&&earliest<until?earliest:null;
  }
  function coverage(source) {
    return { source, records: 0, unique_records: 0, pages: 0, earliest_retrieved: null, latest_retrieved: null,
      retrieval_started_at: new Date().toISOString(), retrieval_completed_at: null,
      termination: 'unavailable', complete_according_to_server_pagination: false,
      duplicate_ids: 0, overlapping_pages: 0, missing_ids: 0, missing_timestamps: 0,
      retries: 0, errors: [], warnings: [], exporter_version: VERSION, schema_version: SCHEMA };
  }
  // Adds a warning once; repeats are counted instead of listed again.
  function warn(c, message) {
    c.warning_counts ??= {};
    c.warning_counts[message] = (c.warning_counts[message] || 0) + 1;
    if (!c.warnings.includes(message)) c.warnings.push(message);
  }
  // Returns the number of records not seen before. Page-boundary overlap (a server that
  // treats its cursor as inclusive) is counted for transparency but is not an error.
  function addRecords(c, records, seen, previous = new Set()) {
    let overlap = 0, fresh = 0;
    for (const record of records) {
      const id = idOf(record);
      if (id == null) { c.missing_ids++; fresh++; }
      else {
        const str = String(id);
        if (seen.has(str)) { c.duplicate_ids++; if (previous.has(str)) overlap++; }
        else { fresh++; seen.add(str); }
      }
      const date = dateOf(record);
      if (!validDate(date)) c.missing_timestamps++;
      else {
        if (!c.earliest_retrieved || Date.parse(date) < Date.parse(c.earliest_retrieved)) c.earliest_retrieved = date;
        if (!c.latest_retrieved || Date.parse(date) > Date.parse(c.latest_retrieved)) c.latest_retrieved = date;
      }
    }
    c.records += records.length;
    c.unique_records += fresh;
    if (overlap) c.overlapping_pages++;
    return fresh;
  }
  const pageIds = records => new Set(records.map(idOf).filter(x => x != null).map(String));
  function finish(c, termination) {
    c.termination = termination;
    c.retrieval_completed_at = new Date().toISOString();
    c.complete_according_to_server_pagination = ['no_next_page','completed','empty'].includes(termination) && !c.errors.length;
    return c;
  }
  function manifest(selected, sources, redaction, media, policy = null) {
    return { exporter_version: VERSION, schema_version: SCHEMA, exported_at: new Date().toISOString(),
      browser: typeof navigator === 'object' ? 'Chrome extension' : 'synthetic test',
      sources_requested: selected, sources_retrieved: Object.values(sources).filter(x => x.pages > 0).map(x => x.source),
      warnings: Object.values(sources).flatMap(x => x.warnings.map(w => {
        const n = x.warning_counts?.[w] || 1;
        return `${x.source}: ${w}${n > 1 ? ` (×${n})` : ''}`;
      })),
      redaction_summary: redaction, media_included: media, collection_policy: policy,
      description: 'Retrieved participant-accessible data; not a claim of complete account history.' };
  }

  /* Analysis-ready tables. Raw pages stay the source of truth; these are flattened, de-duplicated views. */
  const str = v => (v == null ? null : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const firstString = (obj, keys) => { for (const k of keys) if (typeof obj?.[k] === 'string') return obj[k]; return null; };
  const byTime = (a, b) => {
    const x = Date.parse(a.timestamp), y = Date.parse(b.timestamp);
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) - Number.isNaN(y);
    return x - y;
  };
  function senderOf(message) {
    const nature = String(message?.meta?.nature ?? message?.nature ?? message?.sender ?? '').toLowerCase();
    if (/customer|user|human/.test(nature)) return 'user';
    if (/robot|bot|replika/.test(nature)) return 'replika';
    return nature || null;
  }
  const flag = v => (typeof v === 'boolean' ? v : null);
  // Page-level reactions are attached to their message when they name one; the raw page keeps the rest.
  function reactionsByMessage(pages) {
    const map = new Map();
    for (const page of pages || []) for (const r of page?.data?.message_reactions || []) {
      const id = r?.message_id ?? r?.messageId ?? r?.message?.id;
      if (id == null) continue;
      const list = map.get(String(id)) || [];
      list.push(r?.reaction ?? r?.type ?? r);
      map.set(String(id), list);
    }
    return map;
  }
  function chatMessages(pages) {
    const rows = [], seen = new Set(), reactions = reactionsByMessage(pages);
    for (const page of pages || []) {
      (page?.data?.messages || []).forEach((m, index) => {
        const key = m?.id != null ? `id:${m.id}` : `anon:${JSON.stringify(m)}`;
        if (seen.has(key)) return;
        seen.add(key);
        const content = m?.content;
        const type = (content && typeof content === 'object' ? content.type : null) ?? null;
        rows.push({
          message_id: str(m?.id), timestamp: dateOf(m), sender: senderOf(m), sender_raw: str(m?.meta?.nature ?? null),
          content_type: str(type),
          text: typeof content === 'string' ? content : firstString(content, ['text', 'caption', 'title']),
          original_text: content?.originalText || null,
          voice_duration: Number.isFinite(content?.duration) ? content.duration : null,
          is_voice: m?.meta?.voice_message === true || /voice|audio/i.test(type || ''),
          is_romantic: flag(m?.is_romantic), uses_memory: flag(m?.uses_memory), uses_advanced_ai: flag(m?.uses_advanced_ai),
          reroll_type: str(m?.reroll_type ?? null), blurred: flag(m?.blurred),
          reactions: m?.id != null && reactions.has(String(m.id)) ? reactions.get(String(m.id)) : null,
          source_ref: `raw/chat/pages.jsonl#page=${page.page}/index=${index}`
        });
      });
    }
    rows.sort(byTime);
    rows.forEach((row, i) => { row.sequence = i + 1; });
    return rows;
  }
  function diaryEntries(details, previews = []) {
    const rows = [], seen = new Set(), titles = new Map();
    for (const p of previews) if (isDay(p?.date) && typeof p?.title === 'string' && !titles.has(p.date)) titles.set(p.date, p.title);
    for (const detail of details || []) {
      (detail?.data?.entries || []).forEach((e, index) => {
        const key = e?.id != null ? `id:${e.id}` : `${detail.date}#${index}`;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({
          diary_date: detail.date, segment_index: index, entry_id: str(idOf(e)),
          timestamp: dateOf(e), title: firstString(e, ['name', 'title', 'header']) ?? titles.get(detail.date) ?? null,
          text: firstString(e, ['text', 'body', 'content', 'description']),
          image_count: Number.isFinite(e?.image_count) ? e.image_count : null,
          read: flag(e?.read), reaction: str(e?.reaction ?? null),
          source_ref: `raw/diary/details.jsonl#date=${detail.date}/index=${index}`
        });
      });
    }
    return rows.sort((a, b) => a.diary_date.localeCompare(b.diary_date) || a.segment_index - b.segment_index);
  }
  // One row per stored memory (memory/v3). The categories and relations endpoints are lookup
  // tables, so they are joined in as names rather than listed as memories.
  const ABOUT = { customer_facts: 'user', robot_facts: 'replika', persons: 'person' };
  function memoryItems(payloads) {
    const rows = [], seen = new Set();
    const lookup = pattern => {
      const map = new Map();
      for (const p of payloads || []) if (pattern.test(p?.kind || '') && Array.isArray(p.data))
        for (const x of p.data) if (x?.id != null) map.set(String(x.id), firstString(x, ['name', 'title', 'text']));
      return map;
    };
    const categories = lookup(/categor/), relations = lookup(/relation/);
    for (const p of payloads || []) {
      if (!/^memory_v3_?$/.test(p?.kind || '')) continue;
      const data = p.data;
      const groups = Array.isArray(data) ? [['items', data]] : Object.entries(data || {}).filter(([, v]) => Array.isArray(v));
      for (const [group, items] of groups) items.forEach((m, index) => {
        if (!m || typeof m !== 'object') return;
        const key = `${group}/${m.id ?? index}`;
        if (seen.has(key)) return;
        seen.add(key);
        const category = m.category_id ?? m.category ?? null, relation = m.relation_id ?? m.person_id ?? null;
        rows.push({
          about: ABOUT[group] ?? group, group, memory_id: str(m.id),
          text: firstString(m, ['text', 'name', 'description', 'title']),
          category_id: str(category), category_name: category != null ? categories.get(String(category)) ?? null : null,
          relation_id: str(relation), relation_name: relation != null ? relations.get(String(relation)) ?? null : null,
          read: flag(m.read), is_user_edited: flag(m.is_user_edited),
          timestamp: dateOf(m),
          source_ref: `raw/memories/pages.jsonl#kind=${p.kind}/${group}/index=${index}`
        });
      });
    }
    return rows.sort(byTime);
  }
  // Column order for the CSV tables; shared by the exporter and tools/build-tables.js.
  const TABLE_COLUMNS = Object.freeze({
    chat_messages: ['sequence','message_id','timestamp','sender','sender_raw','content_type','text','original_text','is_voice','voice_duration','is_romantic','uses_memory','uses_advanced_ai','reroll_type','blurred','reactions','media_file','source_ref'],
    diary_entries: ['diary_date','segment_index','entry_id','timestamp','title','text','image_count','read','reaction','media_files','source_ref'],
    memories: ['about','group','memory_id','text','category_id','category_name','relation_id','relation_name','read','is_user_edited','timestamp','source_ref']
  });
  function csv(rows, columns) {
    const cell = v => {
      if (v == null) return '';
      const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Byte-order mark so spreadsheet tools read UTF-8 (emoji, accents) correctly.
    return '﻿' + [columns.join(','), ...rows.map(r => columns.map(k => cell(r[k])).join(','))].join('\r\n') + '\r\n';
  }
  return { VERSION, SCHEMA, allowedMedia, isSecretKey, sanitize, scanSecrets, dateOf, diaryCursor, coverage, warn,
    addRecords, pageIds, finish, manifest, chatMessages, diaryEntries, memoryItems, TABLE_COLUMNS, csv };
});
