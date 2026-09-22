(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./core.js'):root.ReplikaCore);if(typeof module==='object'&&module.exports)module.exports=api;else root.ReplikaMedia=api;})(globalThis,function(C){
  'use strict';
  const TIMEOUT=60000;
  const AUDIO=new Set(['mp3','aac','ogg','opus','wav','flac','m4a','webm']),IMAGE=new Set(['jpg','png','gif','webp','heic','avif']);
  async function retrieve(url,kind,fetcher=fetch){
    if(!C.allowedMedia(url))throw Error('media_host_not_allowlisted');
    let response;
    try{response=await fetcher(url,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(TIMEOUT)});}catch(_){throw Error('media_fetch_failed');}
    if(response.redirected)throw Error('unexpected_redirect');
    if(!response.ok)throw Error(response.status===429?'rate_limited':'media_http_error');
    const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    // CDNs often label files as generic binary; those are accepted only if the bytes match the kind below.
    const generic=type===''||type==='application/octet-stream'||type==='binary/octet-stream';
    if(!(generic||(kind==='voice'?type.startsWith('audio/')||type==='video/mp4'||type==='video/webm':type.startsWith('image/'))))throw Error('unexpected_content_type');
    const limit=kind==='voice'?50_000_000:20_000_000;
    const length=Number(response.headers.get('content-length'));
    if(Number.isFinite(length)&&length>limit)throw Error('file_too_large');
    // Enforce the cap while reading, including when Content-Length is absent.
    const reader=response.body?.getReader();
    let bytes;
    try{
      if(reader){
        const chunks=[];let size=0;
        try{
          while(true){const {done,value}=await reader.read();if(done)break;
            size+=value.byteLength;
            if(size>limit){await reader.cancel();throw Error('file_too_large');}
            chunks.push(value);
          }
          bytes=new Uint8Array(size);let offset=0;
          for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        }finally{reader.releaseLock();}
      }else{
        bytes=new Uint8Array(await response.arrayBuffer());
        if(bytes.length>limit)throw Error('file_too_large');
      }
    }catch(error){throw Error(error?.message==='file_too_large'?'file_too_large':'media_fetch_failed');}
    if(!bytes.length)throw Error('empty_file');
    const ext=extension(bytes,type);
    if(generic&&!(kind==='voice'?AUDIO:IMAGE).has(ext))throw Error('unexpected_content_type');
    return{bytes,type,extension:ext};
  }
  const TYPE_EXT={'audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/wave':'wav','audio/ogg':'ogg','audio/opus':'opus',
    'audio/webm':'webm','video/webm':'webm','audio/mp4':'m4a','audio/x-m4a':'m4a','audio/aac':'aac','video/mp4':'m4a','audio/flac':'flac',
    'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/heic':'heic','image/avif':'avif'};
  // File signatures win over the declared type, which CDNs often report as application/octet-stream.
  function extension(bytes,type){
    const at=(offset,text)=>[...text].every((ch,i)=>bytes[offset+i]===ch.charCodeAt(0));
    if(at(0,'ID3')||(bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0&&(bytes[1]&0x06)!==0))return 'mp3';
    if(bytes[0]===0xff&&(bytes[1]&0xf6)===0xf0)return 'aac';
    if(at(0,'OggS'))return 'ogg';
    if(at(0,'RIFF')&&at(8,'WAVE'))return 'wav';
    if(at(0,'RIFF')&&at(8,'WEBP'))return 'webp';
    if(at(0,'fLaC'))return 'flac';
    if(at(4,'ftyp'))return at(8,'heic')||at(8,'heix')?'heic':at(8,'avif')?'avif':'m4a';
    if(bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3)return 'webm';
    if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'jpg';
    if(at(0,'\x89PNG'))return 'png';
    if(at(0,'GIF8'))return 'gif';
    return TYPE_EXT[type]||'bin';
  }
  return{retrieve,extension};
});
