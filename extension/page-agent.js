/* MAIN world: credentials are observed only here and are never posted to the extension. */
(() => {
  'use strict';
  if (window.__replikaResearchAgent) return;
  window.__replikaResearchAgent = true;
  const C = window.ReplikaCore;
  const originalSend = WebSocket.prototype.send;
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalHeader = XMLHttpRequest.prototype.setRequestHeader;
  const base = `${location.origin}/api/mobile/1.5/`;
  const CHAT_PAGE_LIMIT = 100, REQUEST_TIMEOUT = 30000, MAX_RETRIES = 3, MAX_PAGES = 20000;
  let socket = null, socketUrl = null, historyTemplate = null, httpHeaders = null, snapshot = null, running = false, cancelled = false;
  let lastNotice = '';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const post = (kind, requestId, value) => window.postMessage({ channel: 'replika-research-page', kind, requestId, value }, location.origin);
  const classified = error => {
    const name = String(error?.message || 'request_failed');
    if (/429|rate.?limit/i.test(name)) return 'rate_limited';
    if (/401|403|permission/i.test(name)) return 'permission_error';
    return 'error';
  };
  const chatReady = () => Boolean(historyTemplate && socket && socket.readyState === WebSocket.OPEN);
  const readiness = () => ({ loggedIn: Boolean(historyTemplate || httpHeaders), chatReady: chatReady(), apiReady: Boolean(httpHeaders) });
  // Only report when readiness changes; the app issues many requests and each used to trigger a message.
  const notice = (force = false) => {
    const value = readiness(), key = JSON.stringify(value);
    if (!force && key === lastNotice) return;
    lastNotice = key;
    post('status', null, value);
  };
  function rememberHttp(url, headers) {
    try {
      const u = new URL(url, location.origin);
      if (u.origin !== location.origin || !u.pathname.startsWith('/api/mobile/1.5/')) return;
      const h = new Headers(headers || {});
      if (!h.has('x-auth-token') && !h.has('authorization') && !h.has('x-user-id')) return;
      // Body-describing headers from the app's POST/PUT requests must not leak into our GETs.
      for (const name of ['content-type', 'content-length', 'content-encoding']) h.delete(name);
      httpHeaders = h; // transient, never serialized or exported
      notice();
    } catch (_) { /* No request contents in logs. */ }
  }
  window.fetch = function (input, init) {
    try { rememberHttp(input instanceof Request ? input.url : input, init?.headers || (input instanceof Request ? input.headers : null)); } catch (_) {}
    return originalFetch.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__replikaResearchUrl = url;
    this.__replikaResearchHeaders = new Headers();
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { this.__replikaResearchHeaders?.set(name, value); rememberHttp(this.__replikaResearchUrl, this.__replikaResearchHeaders); } catch (_) {}
    return originalHeader.apply(this, arguments);
  };
  WebSocket.prototype.send = function (data) {
    try {
      const frame = typeof data === 'string' ? JSON.parse(data) : null;
      if (frame?.event_name === 'history' && frame.payload?.chat_id) {
        socket = this; socketUrl = this.url; historyTemplate = frame; // never cross the window bridge
      } else if (historyTemplate && this !== socket && this.url === socketUrl && !chatReady()) {
        socket = this; // the app reconnected; keep using its new connection
      }
      notice();
    } catch (_) {}
    return originalSend.call(this, data);
  };
  const http = async path => {
    if (!httpHeaders) throw new Error('api_unavailable');
    const u = new URL(path, base);
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/mobile/1.5/')) throw new Error('invalid_api_path');
    let response;
    try {
      response = await originalFetch.call(window, u.href, { method: 'GET', headers: httpHeaders, credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
    } catch (error) { throw new Error(error?.name === 'TimeoutError' ? 'request_timeout' : 'network_error'); }
    if (!response.ok) throw new Error(response.status === 429 ? 'rate_limited' : `http_${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!type.includes('json')) throw new Error('unexpected_content_type');
    return response.json();
  };
  const history = (cursor, limit) => new Promise((resolve, reject) => {
    if (!chatReady()) return reject(new Error('chat_unavailable'));
    const ws = socket, token = crypto.randomUUID();
    const timer = setTimeout(() => done(new Error('history_timeout')), REQUEST_TIMEOUT);
    function done(error, payload) {
      clearTimeout(timer); ws.removeEventListener('message', onMessage); ws.removeEventListener('close', onClose);
      error ? reject(error) : resolve(payload);
    }
    function onClose() { done(new Error('chat_unavailable')); }
    function onMessage(event) {
      try {
        const frame = JSON.parse(event.data);
        if (frame?.token !== token) return;
        if (frame.event_name === 'error') return done(new Error(/429|rate.?limit/i.test(JSON.stringify(frame.payload)) ? 'rate_limited' : 'history_error'));
        if (frame.event_name !== 'history') return;
        if (!Array.isArray(frame.payload?.messages)) return done(new Error('malformed_history'));
        done(null, frame.payload);
      } catch (_) { /* Ignore unrelated malformed frames. */ }
    }
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    const query = { ...historyTemplate, token, payload: { ...historyTemplate.payload } };
    delete query.payload.last_message_id;
    if (cursor != null) query.payload.last_message_id = cursor;
    if (limit != null && typeof query.payload.limit === 'number') query.payload.limit = Math.max(query.payload.limit, limit);
    try { originalSend.call(ws, JSON.stringify(query)); } catch (_) { done(new Error('chat_unavailable')); }
  });
  const TRANSIENT = new Set(['rate_limited', 'history_timeout', 'request_timeout', 'network_error', 'chat_unavailable', 'http_500', 'http_502', 'http_503', 'http_504']);
  // Retries transient failures with backoff so one hiccup does not end a long collection.
  async function withRetry(s, requestId, fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (error) {
        const reason = String(error?.message || '');
        if (attempt >= MAX_RETRIES || cancelled || !TRANSIENT.has(reason)) throw error;
        const wait = (reason === 'rate_limited' ? 20000 : 3000) * 2 ** attempt;
        s.coverage.retries++;
        progress(requestId, s, { reason: reason === 'rate_limited' ? 'rate_limited' : 'retrying', seconds: Math.round(wait / 1000) });
        for (let waited = 0; waited < wait && !cancelled; waited += 250) await sleep(250);
        if (cancelled) throw error;
      }
    }
  }
  const timestamp = m => m?.meta?.timestamp ?? m?.timestamp ?? null;
  function mediaFrom(value, category, into, context = '', ref = '') {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach((x,i) => mediaFrom(x, category, into, context, `${ref}/index=${i}`)); return; }
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && child && (/(?:voice_message_url|image_url|audio_url|media_url)$/i.test(key) || (key === 'url' && /images?/i.test(context)))) {
        const kind = /voice|audio/i.test(key + context) ? 'voice' : 'diary_images';
        const safeUrl=C.allowedMedia(child)?child:null;
        const sourceRef=`${ref}/${key}`;
        if (kind === category && !into.some(x => x.source_ref === sourceRef && x.url === safeUrl)) into.push({ url: safeUrl, source_ref: sourceRef, media_type: kind });
      } else if (Array.isArray(child) && /images?$/i.test(key) && child.some(x => typeof x === 'string')) {
        // Diary entries carry an `images` array; accept plain links as well as objects with a url.
        child.forEach((x, i) => {
          const sourceRef = `${ref}/${key}/index=${i}`;
          if (typeof x === 'string' && x && category === 'diary_images' && !into.some(y => y.source_ref === sourceRef))
            into.push({ url: C.allowedMedia(x) ? x : null, source_ref: sourceRef, media_type: 'diary_images' });
          else if (x && typeof x === 'object') mediaFrom(x, category, into, key, sourceRef);
        });
      } else if (child && typeof child === 'object') mediaFrom(child, category, into, key, `${ref}/${key}`);
    }
  }
  function source(name) { return { coverage: C.coverage(name), payloads: [], media: [] }; }
  const progress = (requestId, s, waiting = null) => post('progress', requestId, { source: s.coverage.source, records: s.coverage.unique_records, pages: s.coverage.pages, earliest: s.coverage.earliest_retrieved, waiting });
  async function scanChat(requestId) {
    const s = source('chat'), c = s.coverage, seen = new Set(); let previous = new Set(), cursor = null, limit = CHAT_PAGE_LIMIT;
    if (!chatReady()) return C.finish(c, 'unavailable'), s;
    try {
      while (true) {
        if (cancelled) return C.finish(c, 'cancelled'), s;
        if (c.pages >= MAX_PAGES) { C.warn(c, 'Stopped at the page safety limit.'); return C.finish(c, 'error'), s; }
        if (c.pages) await sleep(1000);
        if (cancelled) return C.finish(c, 'cancelled'), s;
        let payload;
        try { payload = await withRetry(s, requestId, () => history(cursor, limit)); }
        catch (error) {
          // A larger page size is only an optimisation; fall back to the app's own size if refused.
          if (!c.pages && limit != null && error?.message === 'history_error') { limit = null; continue; }
          throw error;
        }
        c.pages++;
        const messages = payload.messages;
        const fresh = C.addRecords(c, messages, seen, previous);
        previous = C.pageIds(messages);
        mediaFrom(messages, 'voice', s.media, '', `raw/chat/pages.jsonl#page=${c.pages}`);
        messages.forEach((message,index)=>{
          const ref=`raw/chat/pages.jsonl#page=${c.pages}/index=${index}`;
          if((message?.meta?.voice_message===true||/voice|audio/i.test(message?.content?.type||''))&&!s.media.some(x=>x.source_ref.startsWith(ref+'/')||x.source_ref===ref))
            s.media.push({url:null,source_ref:ref,media_type:'voice'});
        });
        s.payloads.push({ page: c.pages, retrieved_at: new Date().toISOString(), data: C.sanitize(payload) });
        progress(requestId, s);
        if (!messages.length) return C.finish(c, 'empty'), s;
        if (payload.more === false) return C.finish(c, 'no_next_page'), s;
        if (!fresh) {
          // An inclusive cursor returns just the cursor message once history is exhausted.
          if (messages.every(m => m?.id != null && String(m.id) === String(cursor))) return C.finish(c, 'no_next_page'), s;
          C.warn(c, 'Pagination cursor did not advance.'); return C.finish(c, 'error'), s;
        }
        const ordered = messages.filter(m => m?.id != null && !Number.isNaN(Date.parse(timestamp(m)))).sort((a,b) => Date.parse(timestamp(a)) - Date.parse(timestamp(b)));
        const next = (ordered[0] ?? messages.find(m => m?.id != null))?.id;
        if (next == null || String(next) === String(cursor)) { C.warn(c, 'Pagination cursor did not advance.'); return C.finish(c, 'error'), s; }
        cursor = next;
      }
    } catch (error) { c.errors.push(classified(error)); return C.finish(c, classified(error)), s; }
  }
  function arrayFrom(data, names) {
    if (Array.isArray(data)) return data;
    for (const name of names) if (Array.isArray(data?.[name])) return data[name];
    return null;
  }
  const DIARY_ARRAYS = ['diaries','entries','items','results'];
  const isDay = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  async function scanDiary(requestId) {
    const s = source('diary'), c = s.coverage, seen = new Set(), seenDates = new Set();
    let until = new Date(Date.now() + 86400000).toISOString().slice(0,10), previewTermination = 'no_next_page';
    c.dated_previews = 0; c.details_retrieved = 0; c.detail_segments = 0; c.unread_details_skipped = 0; c.detail_failures = 0; c.preview_pagination = [];
    if (!httpHeaders) return C.finish(c, 'unavailable'), s;
    try {
      const counts = await withRetry(s, requestId, () => http('diaries/count'));
      s.payloads.push({ kind: 'counts', retrieved_at: new Date().toISOString(), data: C.sanitize(counts) });
      while (true) {
        if (cancelled) return C.finish(c, 'cancelled'), s;
        if (c.pages >= MAX_PAGES) { C.warn(c, 'Stopped at the page safety limit.'); previewTermination = 'error'; break; }
        if (c.pages) await sleep(750);
        if (cancelled) return C.finish(c, 'cancelled'), s;
        const raw = await withRetry(s, requestId, () => http(`diaries?limit=100&until=${encodeURIComponent(until)}`));
        const previews = arrayFrom(raw, DIARY_ARRAYS);
        if (!previews) throw new Error('malformed_diary_previews');
        c.pages++;
        C.addRecords(c, previews, seen);
        s.payloads.push({ kind: 'previews', page: c.pages, retrieved_at: new Date().toISOString(), data: C.sanitize(raw) });
        const pageDates = [...new Set(previews.map(x => x?.date).filter(isDay))];
        const newDates = pageDates.filter(d => !seenDates.has(d));
        newDates.forEach(d => seenDates.add(d));
        const earliest = C.diaryCursor(previews, until);
        c.preview_pagination.push({ requested_until: until, returned_count: previews.length, new_dates: newDates.length, earliest_date: earliest, server_more: raw?.more??null });
        progress(requestId, s);
        if (!previews.length) break;
        if (!pageDates.length) { C.warn(c, 'Diary previews had no recognisable dates.'); previewTermination = 'error'; break; }
        // Only dates already seen (an inclusive `until` boundary) means there is nothing older.
        if (!newDates.length) break;
        if (!earliest) { C.warn(c, 'Diary preview pagination did not advance.'); previewTermination = 'error'; break; }
        until = earliest;
        if (raw?.more === false) break;
      }
      const previews = s.payloads.filter(x => x.kind === 'previews').flatMap(x => arrayFrom(x.data, DIARY_ARRAYS) || []);
      const dates = [...new Set(previews.map(x => x?.date).filter(isDay))].sort().reverse();
      c.dated_previews = dates.length;
      for (const date of dates) {
        if (cancelled) return C.finish(c, 'cancelled'), s;
        // Every preview for the date must be marked read; opening a detail would mark it read.
        if (!previews.filter(x => x?.date === date).every(x => x?.read === true)) {
          c.unread_details_skipped++; C.warn(c, 'An unread diary detail or one with unknown read state was skipped to preserve read state.'); continue;
        }
        await sleep(500);
        if (cancelled) return C.finish(c, 'cancelled'), s;
        try {
          const raw = await withRetry(s, requestId, () => http(`diaries/${date}`));
          if (!Array.isArray(raw?.entries)) throw new Error('malformed_diary_detail');
          s.payloads.push({ kind: 'detail', date, retrieved_at: new Date().toISOString(), data: C.sanitize(raw) });
          c.pages++;
          c.details_retrieved++; c.detail_segments += raw.entries.length;
          mediaFrom(raw.entries, 'diary_images', s.media, '', `raw/diary/details.jsonl#date=${date}`);
          raw.entries.forEach((entry,index)=>{
            const ref=`raw/diary/details.jsonl#date=${date}/index=${index}`;
            if(entry?.image_count>0&&!s.media.some(x=>x.source_ref.startsWith(ref+'/')||x.source_ref===ref))
              s.media.push({url:null,source_ref:ref,media_type:'diary_images'});
          });
          progress(requestId, s);
        } catch (error) {
          c.detail_failures++;
          C.warn(c, `A diary detail could not be retrieved (${classified(error)}).`);
          if (classified(error) === 'rate_limited') return C.finish(c, 'rate_limited'), s;
        }
      }
      c.preview_pagination_complete = previewTermination === 'no_next_page';
      C.finish(c, previewTermination);
      if (c.unread_details_skipped || c.detail_failures) c.complete_according_to_server_pagination = false;
      return s;
    } catch (error) { c.errors.push(classified(error)); return C.finish(c, classified(error)), s; }
  }
  async function scanOne(requestId, name, paths) {
    const s = source(name), c = s.coverage;
    if (name === 'profile') { c.record_kind = 'current_snapshot'; c.snapshot_at = null; c.registration_date = null; }
    if (!httpHeaders) return C.finish(c, 'unavailable'), s;
    for (const [i, path] of paths.entries()) {
      if (cancelled) return C.finish(c, 'cancelled'), s;
      if (i) await sleep(350);
      try {
        const raw = await withRetry(s, requestId, () => http(path));
        c.pages++;
        if (name === 'profile') {
          c.records++; c.unique_records++;
          c.snapshot_at ??= new Date().toISOString();
          if (path === 'profile' && typeof raw?.registration_date === 'string') c.registration_date = raw.registration_date;
        } else if (path === 'memory/v3/') {
          const arrays = Object.values(raw || {}).filter(Array.isArray);
          const records = Array.isArray(raw) ? raw : arrays.flat();
          if (records.length) C.addRecords(c, records, new Set());
        }
        s.payloads.push({ kind: path.replace(/\W+/g,'_').replace(/^_+|_+$/g,''), retrieved_at: new Date().toISOString(), data: C.sanitize(raw) });
        progress(requestId, s);
      } catch (error) {
        C.warn(c, `${path.replace(/\/+$/,'')} unavailable (${classified(error)}).`);
        if (classified(error) === 'rate_limited') return C.finish(c, 'rate_limited'), s;
      }
    }
    if (name === 'memories') C.warn(c, 'Current memory response inspected; older availability is not established.');
    if (name === 'profile') C.warn(c, 'Current snapshot only; historical values are not established.');
    C.finish(c, c.pages ? 'completed' : 'unavailable');
    if (c.pages !== paths.length) c.complete_according_to_server_pagination = false;
    if (name === 'memories') c.complete_according_to_server_pagination = false;
    return s;
  }
  async function scan(requestId) {
    if (running) return post('error', requestId, 'A scan is already running.');
    running = true; cancelled = false; snapshot = null;
    const result = {};
    try {
      for (const [name, fn] of [
        ['chat', () => scanChat(requestId)], ['diary', () => scanDiary(requestId)],
        ['memories', () => scanOne(requestId, 'memories', ['memory/v3/','memory/v3/unstructured_fact_categories','memory/relations'])],
        ['profile', () => scanOne(requestId, 'profile', ['profile','personal_bot','personal_bot_chat','relationship_statuses','core_description'])]
      ]) {
        if (cancelled) { const s = source(name); C.finish(s.coverage, 'cancelled'); result[name] = s; post('source', requestId, s.coverage); continue; }
        result[name] = await fn();
        post('source', requestId, result[name].coverage);
      }
      snapshot = result; // sanitized data and authorized media candidates only; tab memory
      post('scanDone', requestId, Object.fromEntries(Object.entries(result).map(([k,v]) => [k,{ ...v.coverage, media_candidates: v.media.length }])));
    } catch (_) {
      post('error', requestId, 'Collection stopped unexpectedly.');
    } finally { running = false; }
  }
  async function bootstrap(requestId) {
    const find = path => [...document.querySelectorAll('a[href]')].find(a => {
      try { const u = new URL(a.href, location.origin); return u.origin === location.origin && u.pathname === path; } catch (_) { return false; }
    });
    const wait = async predicate => { for (let i=0;i<80;i++) { if (predicate()) return true; await sleep(100); } return false; };
    try {
      if (!httpHeaders) {
        if (!await wait(() => Boolean(find('/diary')))) throw new Error('navigation_unavailable');
        find('/diary').click();
        await wait(() => Boolean(httpHeaders));
      }
      if (!chatReady()) {
        if (!await wait(() => Boolean(find('/')))) throw new Error('navigation_unavailable');
        find('/').click();
        await wait(chatReady);
      }
    } catch (_) { /* Readiness below tells the exporter what is missing. */ }
    post('bootstrapDone', requestId, { chatReady: chatReady(), apiReady: Boolean(httpHeaders) });
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'replika-research-bridge') return;
    const { kind, requestId } = event.data;
    if (kind === 'status') notice(true);
    if (kind === 'bootstrap') bootstrap(requestId);
    if (kind === 'cancel') cancelled = true;
    if (kind === 'scan') scan(requestId);
    if (kind === 'export') {
      if (running || !snapshot) return post('error', requestId, 'Run a scan before exporting.');
      const selected = Array.isArray(event.data.selected) ? event.data.selected : [];
      post('exportData', requestId, Object.fromEntries(selected.filter(x => snapshot[x]).map(x => [x,snapshot[x]])));
    }
  });
  notice(true);
})();
