/* Minimal ZIP writer using uncompressed entries. No dependencies or network calls. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReplikaZip = api;
})(globalThis, function () {
  'use strict';
  const table = new Uint32Array(256);
  for (let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; table[n]=c>>>0; }
  function crc32(bytes) { let c=0xffffffff; for(let i=0,n=bytes.length;i<n;i++) c=table[(c^bytes[i])&255]^(c>>>8); return (c^0xffffffff)>>>0; }
  // MS-DOS date/time fields; a zero date (1980-00-00) is invalid and some unzip tools warn about it.
  function dosTime(d) {
    return { time: (d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1),
      date: ((Math.max(d.getFullYear(),1980)-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate() };
  }
  const u16 = (view, offset, value) => view.setUint16(offset,value,true);
  const u32 = (view, offset, value) => view.setUint32(offset,value,true);
  function build(entries, now = new Date()) {
    const { time, date } = dosTime(now), encoder = new TextEncoder(), chunks=[], central=[], names=new Set(); let offset=0;
    for (const [name, value] of entries) {
      if (!/^replika-export\/[a-zA-Z0-9_./-]+$/.test(name) || name.includes('..')) throw new Error('Invalid ZIP path');
      if(names.has(name))throw new Error('Duplicate ZIP path');names.add(name);
      const nameBytes=encoder.encode(name), data=typeof value==='string'?encoder.encode(value):value;
      if (!(data instanceof Uint8Array) || data.length>0xffffffff) throw new Error('Invalid ZIP entry');
      const crc=crc32(data), local=new Uint8Array(30+nameBytes.length), l=new DataView(local.buffer);
      u32(l,0,0x04034b50); u16(l,4,20); u16(l,6,0x0800); u16(l,8,0); u16(l,10,time); u16(l,12,date); u32(l,14,crc);
      u32(l,18,data.length); u32(l,22,data.length); u16(l,26,nameBytes.length); local.set(nameBytes,30);
      chunks.push(local,data);
      const head=new Uint8Array(46+nameBytes.length), h=new DataView(head.buffer);
      u32(h,0,0x02014b50); u16(h,4,20); u16(h,6,20); u16(h,8,0x0800); u16(h,10,0); u16(h,12,time); u16(h,14,date);
      u32(h,16,crc); u32(h,20,data.length); u32(h,24,data.length); u16(h,28,nameBytes.length); u32(h,42,offset);
      head.set(nameBytes,46); central.push(head); offset+=local.length+data.length;
    }
    const centralSize=central.reduce((n,x)=>n+x.length,0);
    if (central.length>65535 || offset+centralSize>0xffffffff) throw new Error('ZIP too large');
    const end=new Uint8Array(22), e=new DataView(end.buffer); u32(e,0,0x06054b50);
    u16(e,8,central.length); u16(e,10,central.length); u32(e,12,centralSize); u32(e,16,offset);
    return new Blob([...chunks,...central,end],{type:'application/zip'});
  }
  return { build, crc32 };
});
