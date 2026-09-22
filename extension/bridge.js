/* Isolated world: forwards only data/status messages from the MAIN-world agent. */
(() => {
  'use strict';
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
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'replika-research-page') return;
    if (!['status','bootstrapDone','progress','source','scanDone','exportData','error'].includes(event.data.kind)) return;
    for (const port of ports) try { port.postMessage({ kind: event.data.kind, requestId: event.data.requestId, value: event.data.value }); } catch (_) {}
  });
})();
