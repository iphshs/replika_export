/* Isolated world: forwards only data/status messages from the MAIN-world agent. */
(() => {
  'use strict';
  // Extension ports reject messages over 64 MiB, which a long chat history can exceed,
  // so the export is sent as serialized text in parts and reassembled by the exporter.
  const PART_CHARS = 4 * 1024 * 1024;
  const ports = new Set();
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'replika-research') return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener(message => {
      if (!['status','bootstrap','scan','cancel','export'].includes(message?.kind)) return;
      window.postMessage({ channel: 'replika-research-bridge', kind: message.kind, requestId: message.requestId, selected: message.selected }, location.origin);
    });
    window.postMessage({ channel: 'replika-research-bridge', kind: 'status' }, location.origin);
  });
  function send(message) {
    for (const port of ports) try { port.postMessage(message); } catch (_) {}
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'replika-research-page') return;
    const { kind, requestId, value } = event.data;
    if (!['status','bootstrapDone','progress','source','scanDone','exportData','error'].includes(kind)) return;
    if (kind !== 'exportData') return send({ kind, requestId, value });
    let text;
    try { text = JSON.stringify(value); } catch (_) { return send({ kind: 'error', requestId, value: 'Export could not be serialized.' }); }
    const parts = [];
    for (let start = 0; start < text.length || !parts.length;) {
      let end = Math.min(start + PART_CHARS, text.length);
      // Never split a surrogate pair: a lone half would be replaced in transit and corrupt emoji.
      if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--;
      parts.push(text.slice(start, end));
      start = end;
    }
    parts.forEach((part, index) => send({ kind: 'exportPart', requestId, value: { index, total: parts.length, text: part } }));
  });
})();
