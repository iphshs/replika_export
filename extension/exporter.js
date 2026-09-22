(() => {
  'use strict';
  const C=ReplikaCore, P=ReplikaStudyPolicy, $=id=>document.getElementById(id);
  const labels={chat:'Chat',diary:'Diary',memories:'Memories',profile:'Account information'};
  let port=null, requestId=null, report=null, stage='idle', cancelled=false, prepared=null;
  let readiness={chatReady:false,apiReady:false};
  const status=(text,help='')=>{$('connection').textContent=text;$('connection-help').textContent=help;};
  function render(report) {
    $('sources').replaceChildren();
    for(const [name,c] of Object.entries(report)) {
      const box=document.createElement('div');box.className='source';
      const title=document.createElement('strong');title.textContent=labels[name]||name;box.append(title);
      const lines=[
        name==='diary'?`${c.dated_previews||0} diary dates · ${c.detail_segments||0} entries`:
          name==='profile'?(c.pages?`Current account snapshot (${c.pages} sources)`:'No account snapshot retrieved'):
          `${c.records} records retrieved`,
        c.earliest_retrieved?`Earliest retrieved: ${c.earliest_retrieved}`:null,
        c.latest_retrieved?`Latest retrieved: ${c.latest_retrieved}`:null,
        c.termination==='cancelled'?'Collection cancelled; these records are partial.':
        c.termination==='rate_limited'?'Replika temporarily limited requests; these records are partial.':
        c.termination==='error'||c.termination==='permission_error'?'Retrieval stopped early; review this partial result.':
        c.termination==='unavailable'?'This source was unavailable.':null,
        name==='diary'&&c.unread_details_skipped?'An unread diary detail was skipped to preserve its state.':null,
        ...c.warnings.filter(x=>!x.includes('unread diary detail')).slice(0,2)
      ].filter(Boolean);
      for(const line of lines){const p=document.createElement('p');p.textContent=line;box.append(p);} $('sources').append(box);
    }
  }
  function connect(id) {
    port=chrome.tabs.connect(id,{name:'replika-research'});
    port.onDisconnect.addListener(()=>{port=null;status('Replika connection closed','Open Replika, then try again.');$('create').disabled=false;$('open-replika').hidden=false;});
    port.onMessage.addListener(handle);port.postMessage({kind:'status'});
  }
  async function findTab() {
    const tabs=await chrome.tabs.query({url:'https://my.replika.com/*'});
    if(!tabs.length){status('Open Replika to begin','Log in normally, then return here.');$('open-replika').hidden=false;return;}
    connect(tabs[0].id);
  }
  function startScan() {stage='scanning';$('progress').textContent='Preparing your research data…';port.postMessage({kind:'scan',requestId});}
  function handle(message) {
    if(message.kind==='status'){
      readiness=message.value;
      status(readiness.loggedIn?'Connected to Replika':'Replika is open','Select Create My Research Data to begin.');return;
    }
    if(message.requestId!==requestId)return;
    if(message.kind==='bootstrapDone') {
      readiness={...readiness,...message.value};
      if(!readiness.chatReady||!readiness.apiReady){stage='idle';$('create').disabled=false;$('cancel').disabled=true;
        $('progress').textContent='Open Replika and wait for it to finish loading, then try again.';$('open-replika').hidden=false;return;}
      if(cancelled){stage='idle';$('create').disabled=false;$('cancel').disabled=true;$('progress').textContent='Collection cancelled before it started.';return;}
      startScan();
    }
    if(message.kind==='progress'){
      const v=message.value;$('progress').textContent=`${labels[v.source]||v.source}: ${v.records} retrieved${v.earliest?`; earliest so far ${v.earliest}`:''}.`;
    }
    if(message.kind==='source'){report??={};report[message.value.source]=message.value;render(report);}
    if(message.kind==='scanDone'){
      report=message.value;render(report);stage='preparing';$('progress').textContent='Preparing your local collection and study media…';
      port.postMessage({kind:'export',requestId,selected:P.sources});
    }
    if(message.kind==='exportData')prepare(message.value).catch(()=>fail('The local dataset could not be prepared. You can try again.'));
    if(message.kind==='error')fail('Collection stopped. Open Replika and try again.');
  }
  function fail(message){stage='idle';$('create').disabled=false;$('cancel').disabled=true;$('progress').textContent=message;}
  $('create').addEventListener('click',async()=>{
    if(!port){await findTab();if(!port)return;}
    requestId=crypto.randomUUID();report=null;prepared=null;cancelled=false;stage='bootstrapping';
    $('ready').hidden=true;$('sources').replaceChildren();$('create').disabled=true;$('cancel').disabled=false;
    $('progress').textContent='Connecting to Replika…';
    if(readiness.chatReady&&readiness.apiReady)startScan();else port.postMessage({kind:'bootstrap',requestId});
  });
  $('open-replika').addEventListener('click',()=>chrome.tabs.create({url:'https://my.replika.com/'}));
  $('cancel').addEventListener('click',()=>{
    cancelled=true;if(stage==='scanning'&&port)port.postMessage({kind:'cancel',requestId});
    $('progress').textContent='Stopping after the current request or file…';
  });
  const json=x=>JSON.stringify(x,null,2)+'\n';
  const jsonl=xs=>xs.map(x=>JSON.stringify(x)).join('\n')+(xs.length?'\n':'');
  const extFor=type=>({'audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg','audio/webm':'webm','image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'})[type]||'bin';
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
    for(const [kind,enabled,source,prefix]of [['voice',P.voice_audio,'chat','media/voice'],['diary_images',P.diary_images,'diary','media/diary-images']]){
      let index=0,rateLimited=false;
      for(const candidate of data[source]?.media||[]){
        const item={source_ref:candidate.source_ref,media_type:kind,media_present:true,media_collection_enabled:enabled,
          media_content_collected:false,media_collection_status:enabled?'pending':'not_collected',media_file_reference:null,media_collection_error:null};
        mediaRecords.push(item);mediaSummary[kind].present++;
        if(!enabled)continue;
        if(!candidate.url){item.media_collection_status='failed';item.media_collection_error='media_url_unavailable';mediaSummary[kind].failed++;continue;}
        if(rateLimited){item.media_collection_status='not_attempted_rate_limited';continue;}
        if(cancelled){item.media_collection_status='cancelled';sources[source].termination='cancelled';sources[source].complete_according_to_server_pagination=false;continue;}
        $('progress').textContent=`Collecting ${kind==='voice'?'voice audio':'diary images'}: ${index+1} of ${data[source].media.length}…`;
        try{
          const file=await ReplikaMedia.retrieve(candidate.url,kind);
          const filename=`${prefix}/${String(++index).padStart(4,'0')}.${extFor(file.type)}`;
          entries.push([`replika-export/${filename}`,file.bytes]);
          item.media_content_collected=true;item.media_collection_status='collected';item.media_file_reference=filename;mediaSummary[kind].collected++;
        }catch(error){item.media_collection_status='failed';item.media_collection_error=['rate_limited','media_host_not_allowlisted','unexpected_redirect','unexpected_content_type','file_too_large','media_http_error'].includes(error?.message)?error.message:'media_fetch_failed';mediaSummary[kind].failed++;
          sources[source].warnings.push(`${kind} file could not be collected.`);
          if(item.media_collection_error==='rate_limited'){sources[source].termination='rate_limited';sources[source].complete_according_to_server_pagination=false;rateLimited=true;}
        }
      }
    }
    put('raw/media/collection.jsonl',jsonl(mediaRecords));
    const summary={schema_version:C.SCHEMA,exporter_version:C.VERSION,sources,media:mediaSummary};
    put('export_summary.json',summary);
    put('manifest.json',C.manifest(P.sources,sources,redaction,{voice:mediaSummary.voice.collected>0,diary_images:mediaSummary.diary_images.collected>0},P));
    prepared=ReplikaZip.build(entries);
    render(sources);
    stage='ready';$('cancel').disabled=true;$('create').disabled=false;$('ready').hidden=false;
    const partial=Object.values(sources).some(c=>!c.complete_according_to_server_pagination);
    $('ready-message').textContent=partial?'Your collection includes partial or current-snapshot sources. Review the summary below before saving a copy.':'Your local collection is ready. Review the summary below before saving a copy.';
    $('media-summary').textContent=`Voice audio: ${mediaSummary.voice.collected} of ${mediaSummary.voice.present} found files collected. Diary images: ${mediaSummary.diary_images.collected} of ${mediaSummary.diary_images.present} found files collected.`;
    $('progress').textContent='Research data prepared locally. No submission has occurred.';
  }
  $('download').addEventListener('click',async()=>{
    if(!prepared)return;
    const url=URL.createObjectURL(prepared);
    $('download-status').textContent='Choose a name and location in Chrome’s Save dialog. Keep your copy private.';
    try{await chrome.downloads.download({url,filename:`replika-research-copy-${new Date().toISOString().slice(0,10)}.zip`,saveAs:true});}
    catch(_){$('download-status').textContent='Chrome could not start the download. Try again.';}
    finally{setTimeout(()=>URL.revokeObjectURL(url),60000);}
  });
  findTab().catch(()=>status('Could not connect to Replika','Open Replika and try again.'));
})();
