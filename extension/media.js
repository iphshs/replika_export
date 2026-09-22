(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./core.js'):root.ReplikaCore);if(typeof module==='object'&&module.exports)module.exports=api;else root.ReplikaMedia=api;})(globalThis,function(C){
  'use strict';
  async function retrieve(url,kind,fetcher=fetch){
    if(!C.allowedMedia(url))throw Error('media_host_not_allowlisted');
    let response;
    try{response=await fetcher(url,{credentials:'omit',redirect:'error',cache:'no-store'});}catch(_){throw Error('media_fetch_failed');}
    if(response.redirected)throw Error('unexpected_redirect');
    if(!response.ok)throw Error(response.status===429?'rate_limited':'media_http_error');
    const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(!(kind==='voice'?type.startsWith('audio/')||type==='application/octet-stream':type.startsWith('image/')))throw Error('unexpected_content_type');
    const limit=kind==='voice'?50_000_000:20_000_000;
    const length=Number(response.headers.get('content-length'));
    if(Number.isFinite(length)&&length>limit)throw Error('file_too_large');
    // Enforce the cap while reading, including when Content-Length is absent.
    const reader=response.body?.getReader();
    let bytes;
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
    return{bytes,type};
  }
  return{retrieve};
});
