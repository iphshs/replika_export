(() => {
  'use strict';
  const C=ReplikaCore, P=ReplikaStudyPolicy, $=id=>document.getElementById(id);
  const labels={chat:'Chat',diary:'Diary',memories:'Memories',profile:'Account information'};
  let port=null, tabId=null, requestId=null, report=null, stage='idle', cancelled=false, prepared=null, saved=false, parts=null;
  let readiness={chatReady:false,apiReady:false};
  const busy=()=>['bootstrapping','scanning','transferring','preparing'].includes(stage);
  const status=(text,help='')=>{$('connection').textContent=text;$('connection-help').textContent=help;};
  // One recovery button: open Replika when no tab exists, reload it when our scripts are missing.
  function offer(action){
    const b=$('open-replika');b.hidden=!action;b.dataset.action=action||'';
    b.textContent=action==='reload'?'Reload Replika tab':'Open Replika';
  }
  function render(report) {
    $('sources').replaceChildren();
    for(const [name,c] of Object.entries(report)) {
      const box=document.createElement('div');box.className='source';
      const title=document.createElement('strong');title.textContent=labels[name]||name;box.append(title);
      const lines=[
        name==='diary'?`${c.dated_previews||0} diary dates · ${c.detail_segments||0} entries`:
          name==='profile'?(c.pages?`Current account snapshot (${c.pages} sources)`:'No account snapshot retrieved'):
          `${c.unique_records??c.records} records retrieved`,
        c.earliest_retrieved?`Earliest retrieved: ${c.earliest_retrieved}`:null,
        c.latest_retrieved?`Latest retrieved: ${c.latest_retrieved}`:null,
        c.termination==='cancelled'?'Collection cancelled; these records are partial.':
        c.termination==='rate_limited'?'Replika temporarily limited requests; these records are partial.':
        c.termination==='error'||c.termination==='permission_error'?'Retrieval stopped early; review this partial result.':
        c.termination==='unavailable'?'This source was unavailable.':null,
        name==='diary'&&c.unread_details_skipped?`${c.unread_details_skipped} unread diary date(s) skipped to preserve their read state.`:null,
        ...c.warnings.filter(x=>!x.includes('unread diary detail')).slice(0,2)
      ].filter(Boolean);
      for(const line of lines){const p=document.createElement('p');p.textContent=line;box.append(p);} $('sources').append(box);
    }
  }
  // Resolves true once the page agent answers; a tab loaded before installation has no agent.
  function connect(id) {
    return new Promise(resolve=>{
      let answered=false,gone=false;
      const p=chrome.tabs.connect(id,{name:'replika-research'});
      const timer=setTimeout(()=>{if(!answered){try{p.disconnect();}catch(_){}onGone();}},3000);
      function onGone(){
        if(gone)return;gone=true;clearTimeout(timer);
        if(port===p)port=null;
        if(!answered){answered=true;status('Reload your Replika tab','The Replika tab was opened before this exporter was installed or updated. Reload it, wait for your chat to appear, then try again.');offer('reload');resolve(false);return;}
        if(busy()){fail('The Replika tab was closed or reloaded during collection. Your partial results were not kept. Try again.');}
        status('Replika connection closed','Open or reload Replika, then try again.');offer(tabId?'reload':'open');$('create').disabled=false;
      }
      p.onDisconnect.addListener(()=>{void chrome.runtime.lastError;onGone();});
      p.onMessage.addListener(message=>{
        if(!answered&&message.kind==='status'){answered=true;clearTimeout(timer);port=p;tabId=id;offer(null);resolve(true);}
        handle(message);
      });
      try{p.postMessage({kind:'status'});}catch(_){onGone();}
    });
  }
  async function findTab() {
    const tabs=await chrome.tabs.query({url:'https://my.replika.com/*'});
    if(!tabs.length){status('Open Replika to begin','Log in normally, then return here.');offer('open');return false;}
    // Prefer the most recently used Replika tab when several are open.
    tabs.sort((a,b)=>(b.active-a.active)||((b.lastAccessed||0)-(a.lastAccessed||0)));
    return connect(tabs[0].id);
  }
  function startScan() {stage='scanning';$('progress').textContent='Collecting your data…';port.postMessage({kind:'scan',requestId});}
  function handle(message) {
    if(message.kind==='status'){
      readiness=message.value;
      if(!busy())status(readiness.loggedIn?'Connected to Replika':'Replika is open',readiness.loggedIn?'Select Create My Research Data to begin.':'Log in to Replika if you have not already, then select Create My Research Data.');
      return;
    }
    if(message.requestId!==requestId)return;
    if(message.kind==='bootstrapDone') {
      readiness={...readiness,...message.value};
      if(cancelled){stage='idle';$('create').disabled=false;$('cancel').disabled=true;$('progress').textContent='Collection cancelled before it started.';return;}
      if(!readiness.chatReady&&!readiness.apiReady){stage='idle';$('create').disabled=false;$('cancel').disabled=true;
        $('progress').textContent='Replika has not finished loading. Make sure you are logged in and your chat is visible, then try again.';offer('reload');return;}
      // A partly ready session still yields the available sources; the summary marks the rest unavailable.
      startScan();
    }
    if(message.kind==='progress'){
      const v=message.value,name=labels[v.source]||v.source;
      $('progress').textContent=v.waiting?(v.waiting.reason==='rate_limited'
        ?`${name}: Replika asked us to slow down. Waiting ${v.waiting.seconds}s before continuing automatically…`
        :`${name}: connection hiccup. Retrying in ${v.waiting.seconds}s…`)
        :`${name}: ${v.records} retrieved${v.earliest?`; earliest so far ${v.earliest}`:''}.`;
    }
    if(message.kind==='source'){report??={};report[message.value.source]=message.value;render(report);}
    if(message.kind==='scanDone'){
      report=message.value;render(report);stage='transferring';parts=[];$('progress').textContent='Preparing your local collection…';
      port.postMessage({kind:'export',requestId,selected:P.sources});
    }
    if(message.kind==='exportPart'&&parts){
      const {index,total,text}=message.value;parts[index]=text;
      if(total>1)$('progress').textContent=`Transferring collected data… ${Math.round(100*parts.filter(x=>x!=null).length/total)}%`;
      if(parts.length===total&&!parts.includes(undefined)){
        let data;
        try{data=JSON.parse(parts.join(''));}catch(_){return fail('The collected data could not be transferred. You can try again.');}
        parts=null;stage='preparing';
        prepare(data).catch(()=>fail('The local dataset could not be prepared. You can try again.'));
      }
    }
    if(message.kind==='error')fail('Collection stopped. Reload Replika and try again.');
  }
  function fail(message){stage='idle';parts=null;$('create').disabled=false;$('cancel').disabled=true;$('progress').textContent=message;}
  $('create').addEventListener('click',async()=>{
    if(!port&&!await findTab())return;
    if(prepared&&!saved&&!confirm('Your previous collection has not been downloaded. Start a new one and discard it?'))return;
    requestId=crypto.randomUUID();report=null;prepared=null;saved=false;cancelled=false;stage='bootstrapping';
    $('ready').hidden=true;$('download-status').textContent='';$('sources').replaceChildren();$('create').disabled=true;$('cancel').disabled=false;
    $('progress').textContent='Connecting to Replika…';
    port.postMessage({kind:'bootstrap',requestId});
  });
  $('open-replika').addEventListener('click',async()=>{
    if($('open-replika').dataset.action==='reload'&&tabId!=null){
      try{await chrome.tabs.reload(tabId);}catch(_){tabId=null;}
      if(tabId!=null){status('Reloading Replika…','Wait for your chat to appear.');setTimeout(()=>findTab().catch(()=>{}),4000);return;}
    }
    if($('open-replika').dataset.action==='reload'){
      const tabs=await chrome.tabs.query({url:'https://my.replika.com/*'});
      if(tabs[0]){await chrome.tabs.reload(tabs[0].id);status('Reloading Replika…','Wait for your chat to appear.');setTimeout(()=>findTab().catch(()=>{}),4000);return;}
    }
    await chrome.tabs.create({url:'https://my.replika.com/'});
    status('Waiting for Replika…','Log in if asked, then return to this tab.');
    setTimeout(()=>findTab().catch(()=>{}),5000);
  });
  // Reconnect quietly when the user comes back from the Replika tab.
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&!port&&!busy())findTab().catch(()=>{});});
  $('cancel').addEventListener('click',()=>{
    cancelled=true;if(stage==='scanning'&&port)port.postMessage({kind:'cancel',requestId});
    $('progress').textContent='Stopping after the current request or file…';
  });
  window.addEventListener('beforeunload',event=>{if(busy()||(prepared&&!saved)){event.preventDefault();event.returnValue='';}});
  const json=x=>JSON.stringify(x,null,2)+'\n';
  const jsonl=xs=>xs.map(x=>JSON.stringify(x)).join('\n')+(xs.length?'\n':'');
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const MEDIA_ERRORS=['rate_limited','media_host_not_allowlisted','unexpected_redirect','unexpected_content_type','file_too_large','media_http_error','empty_file'];
  const TABLES={
    chat:['sequence','message_id','timestamp','sender','sender_raw','content_type','text','original_text','is_voice','is_romantic','uses_memory','uses_advanced_ai','reroll_type','blurred','reactions','media_file','source_ref'],
    diary:['diary_date','segment_index','entry_id','timestamp','title','text','image_count','media_files','source_ref'],
    memories:['endpoint','group','memory_id','text','category','person','timestamp','source_ref']
  };
  async function prepare(data){
    const entries=[],sources={},redaction={secret_fields_replaced:0,url_values_replaced:0},mediaSummary={voice:{present:0,collected:0,failed:0},diary_images:{present:0,collected:0,failed:0}},mediaRecords=[];
    const put=(name,value)=>entries.push([`replika-export/${name}`,typeof value==='string'?value:json(value)]);
    for(const [name,item]of Object.entries(data)){
      sources[name]=structuredClone(item.coverage);
      for(const payload of item.payloads){
        const finding=C.scanSecrets(payload.data);if(finding.secretFields||finding.urlValues)throw Error('unsafe_payload');
        const raw=JSON.stringify(payload.data);
        redaction.secret_fields_replaced+=(raw.match(/\[REDACTED\]/g)||[]).length;
        redaction.url_values_replaced+=(raw.match(/\[REDACTED_URL\]/g)||[]).length;
      }
      if(name==='chat')put('raw/chat/pages.jsonl',jsonl(item.payloads));
      if(name==='diary'){
        put('raw/diary/previews.jsonl',jsonl(item.payloads.filter(x=>x.kind==='previews'||x.kind==='counts')));
        put('raw/diary/details.jsonl',jsonl(item.payloads.filter(x=>x.kind==='detail')));
      }
      if(name==='memories')put('raw/memories/pages.jsonl',jsonl(item.payloads));
      if(name==='profile')for(const p of item.payloads)put(`raw/profile/${p.kind}.json`,p.data);
    }
    const mediaByRef=new Map();
    for(const [kind,enabled,source,prefix]of [['voice',P.voice_audio,'chat','media/voice'],['diary_images',P.diary_images,'diary','media/diary-images']]){
      const candidates=data[source]?.media||[],byUrl=new Map();let index=0,attempt=0,rateLimited=false;
      for(const candidate of candidates){
        const item={source_ref:candidate.source_ref,media_type:kind,media_present:true,media_collection_enabled:enabled,
          media_content_collected:false,media_collection_status:enabled?'pending':'not_collected',media_file_reference:null,media_collection_error:null};
        mediaRecords.push(item);mediaSummary[kind].present++;attempt++;
        if(!enabled)continue;
        if(!candidate.url){item.media_collection_status='failed';item.media_collection_error='media_url_unavailable';mediaSummary[kind].failed++;continue;}
        // The same file referenced twice (e.g. message content and metadata) is stored once.
        if(byUrl.has(candidate.url)){const prior=byUrl.get(candidate.url);Object.assign(item,{media_content_collected:prior.media_content_collected,media_collection_status:prior.media_collection_status,media_file_reference:prior.media_file_reference,media_collection_error:prior.media_collection_error,duplicate_of:prior.source_ref});
          if(prior.media_content_collected){mediaSummary[kind].collected++;mediaByRef.set(item.source_ref,prior.media_file_reference);}else mediaSummary[kind].failed++;continue;}
        byUrl.set(candidate.url,item);
        if(rateLimited){item.media_collection_status='not_attempted_rate_limited';continue;}
        if(cancelled){item.media_collection_status='cancelled';sources[source].termination='cancelled';sources[source].complete_according_to_server_pagination=false;continue;}
        $('progress').textContent=`Collecting ${kind==='voice'?'voice audio':'diary images'}: ${attempt} of ${candidates.length}…`;
        for(let tries=0;;tries++){
          try{
            const file=await ReplikaMedia.retrieve(candidate.url,kind);
            const filename=`${prefix}/${String(++index).padStart(4,'0')}.${file.extension}`;
            entries.push([`replika-export/${filename}`,file.bytes]);
            Object.assign(item,{media_content_collected:true,media_collection_status:'collected',media_file_reference:filename,media_content_type:file.type,media_bytes:file.bytes.length,media_collection_error:null});
            mediaSummary[kind].collected++;mediaByRef.set(item.source_ref,filename);
            break;
          }catch(error){
            const reason=MEDIA_ERRORS.includes(error?.message)?error.message:'media_fetch_failed';
            if((reason==='rate_limited'||reason==='media_fetch_failed')&&tries<2&&!cancelled){
              const wait=(reason==='rate_limited'?15000:2000)*2**tries;
              $('progress').textContent=`${reason==='rate_limited'?'Media host asked us to slow down':'Media download hiccup'}. Retrying in ${Math.round(wait/1000)}s…`;
              sources[source].retries=(sources[source].retries||0)+1;await sleep(wait);continue;
            }
            item.media_collection_status='failed';item.media_collection_error=reason;mediaSummary[kind].failed++;
            C.warn(sources[source],`${kind==='voice'?'Voice':'Diary image'} file could not be collected (${reason}).`);
            if(reason==='rate_limited'){sources[source].termination='rate_limited';sources[source].complete_according_to_server_pagination=false;rateLimited=true;}
            break;
          }
        }
        await sleep(200);
      }
    }
    put('raw/media/collection.jsonl',jsonl(mediaRecords));
    // Analysis-ready tables: one row per message / diary segment / memory, de-duplicated and linked to media.
    const filesByRow=new Map();
    for(const [ref,file]of mediaByRef){
      const row=(ref.match(/^[^#]+#(?:page=\d+|date=[\d-]+)\/index=\d+/)||[])[0];if(!row)continue;
      const list=filesByRow.get(row)||[];if(!list.includes(file))list.push(file);filesByRow.set(row,list);
    }
    const filesFor=row=>filesByRow.get(row.source_ref)||[];
    const tables={};
    if(data.chat){tables.chat=C.chatMessages(data.chat.payloads);for(const r of tables.chat)r.media_file=filesFor(r)[0]??null;}
    if(data.diary){tables.diary=C.diaryEntries(data.diary.payloads.filter(x=>x.kind==='detail'));for(const r of tables.diary)r.media_files=filesFor(r).join(';')||null;}
    if(data.memories)tables.memories=C.memoryItems(data.memories.payloads);
    const tableNames={chat:'chat_messages',diary:'diary_entries',memories:'memories'};
    for(const [name,rows]of Object.entries(tables)){
      put(`tables/${tableNames[name]}.jsonl`,jsonl(rows));
      put(`tables/${tableNames[name]}.csv`,C.csv(rows,TABLES[name]));
      sources[name].table_rows=rows.length;
    }
    const summary={schema_version:C.SCHEMA,exporter_version:C.VERSION,sources,media:mediaSummary,
      tables:Object.fromEntries(Object.entries(tables).map(([k,v])=>[tableNames[k],v.length]))};
    put('export_summary.json',summary);
    put('manifest.json',C.manifest(P.sources,sources,redaction,{voice:mediaSummary.voice.collected>0,diary_images:mediaSummary.diary_images.collected>0},P));
    put('README.txt',readme(tables));
    $('progress').textContent='Building your ZIP file…';await sleep(30);
    prepared=ReplikaZip.build(entries);
    render(sources);
    stage='ready';$('cancel').disabled=true;$('create').disabled=false;$('ready').hidden=false;
    const partial=Object.values(sources).some(c=>!c.complete_according_to_server_pagination);
    $('ready-message').textContent=partial?'Your collection includes partial or current-snapshot sources. Review the summary below before saving a copy.':'Your local collection is ready. Review the summary below before saving a copy.';
    $('media-summary').textContent=`Voice audio: ${mediaSummary.voice.collected} of ${mediaSummary.voice.present} found files collected. Diary images: ${mediaSummary.diary_images.collected} of ${mediaSummary.diary_images.present} found files collected.`;
    $('progress').textContent=`Research data prepared locally (${(prepared.size/1048576).toFixed(1)} MB). No submission has occurred.`;
    $('download').focus();
  }
  function readme(tables){
    return [
      `REPLIKA EXPORT — exporter ${C.VERSION}, schema ${C.SCHEMA}`,
      `Created ${new Date().toISOString()} (all timestamps are UTC unless the source said otherwise).`,
      '',
      'START HERE',
      '  tables/          Analysis-ready tables, one row per item, de-duplicated. CSV opens in spreadsheets; JSONL suits scripts.',
      tables.chat?`    chat_messages   ${tables.chat.length} rows, oldest first. sender is "user" or "replika"; sequence is chronological order.`:null,
      tables.diary?`    diary_entries   ${tables.diary.length} rows, one per diary segment of already-read dates.`:null,
      tables.memories?`    memories        ${tables.memories.length} rows across the memory endpoints.`:null,
      '  export_summary.json  Per-source counts, date range, how retrieval ended, retries, and warnings.',
      '  manifest.json        Export metadata and redaction counts.',
      '  raw/             Sanitized server responses exactly as paged. Every table row has a source_ref pointing here.',
      '  media/           Voice audio and diary images; raw/media/collection.jsonl records each file\'s status.',
      '',
      'PRIVACY',
      '  Login tokens, cookies and similar fields are replaced with [REDACTED]. Web addresses inside any text are',
      '  replaced with [REDACTED_URL]; the rest of the text is kept. Everything else is your own account data: keep it private.',
      '',
      'COMPLETENESS',
      '  complete_according_to_server_pagination means Replika reported no further pages. It is not proof that',
      '  every item Replika ever stored is included. Unread diary dates are skipped so they stay unread.',
      ''
    ].filter(x=>x!=null).join('\n');
  }
  $('download').addEventListener('click',async()=>{
    if(!prepared)return;
    const url=URL.createObjectURL(prepared);
    $('download-status').textContent='Choose a name and location in Chrome’s Save dialog. Keep your copy private.';
    let id=null;
    // The blob must outlive the Save dialog, so it is released only when Chrome finishes or gives up.
    const release=()=>URL.revokeObjectURL(url);
    try{id=await chrome.downloads.download({url,filename:`replika-research-copy-${new Date().toISOString().slice(0,10)}.zip`,saveAs:true});}
    catch(_){release();$('download-status').textContent='Chrome could not start the download. Try again.';return;}
    const listener=delta=>{
      if(delta.id!==id||!delta.state)return;
      if(delta.state.current==='complete'){saved=true;$('download-status').textContent='Saved. Extract the ZIP and open README.txt to find your files.';}
      else if(delta.state.current==='interrupted')$('download-status').textContent='The download was cancelled or interrupted. Click Download My Copy to try again.';
      else return;
      chrome.downloads.onChanged.removeListener(listener);release();
    };
    chrome.downloads.onChanged.addListener(listener);
  });
  findTab().catch(()=>status('Could not connect to Replika','Open Replika and try again.'));
})();
