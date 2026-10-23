import yauzl from 'yauzl';
// Enforce actual streamed output, not only the attacker's ZIP directory sizes.
export function readBoundedZip(bytes, { maxEntries=5000, maxTotal=100*1024*1024, maxEntry=50*1024*1024, allowName=()=>true, collect=true }={}) {
  return new Promise((resolve,reject)=>{
    yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true,autoClose:true},(error,zip)=>{
      if(error)return reject(error);
      let count=0,total=0,stopped=false;
      const files=new Map(),names=new Set();
      const fail=error=>{if(stopped)return;stopped=true;zip.close();reject(error);};
      zip.on('error',fail);
      zip.on('entry',entry=>{
        if(stopped)return;
        if(++count>maxEntries||entry.generalPurposeBitFlag&1||!allowName(entry.fileName)||names.has(entry.fileName))return fail(new Error('Unsafe or excessive archive entries'));
        names.add(entry.fileName);
        if(entry.uncompressedSize>maxEntry||total+entry.uncompressedSize>maxTotal)return fail(new Error('Archive exceeds expanded size limits'));
        if(entry.fileName.endsWith('/')){zip.readEntry();return;}
        zip.openReadStream(entry,(error,stream)=>{
          if(error)return fail(error);
          let size=0;const chunks=[];
          stream.on('data',chunk=>{
            size+=chunk.length;total+=chunk.length;
            if(size>maxEntry||total>maxTotal){stream.destroy();fail(new Error('Archive exceeds actual expanded size limits'));return;}
            if(collect)chunks.push(chunk);
          });
          stream.on('error',fail);
          stream.on('end',()=>{
            if(stopped)return;
            if(size!==entry.uncompressedSize)return fail(new Error('Archive entry size mismatch'));
            files.set(entry.fileName,collect?Buffer.concat(chunks):size);zip.readEntry();
          });
        });
      });
      zip.on('end',()=>{if(!stopped){stopped=true;resolve(files);}});
      zip.readEntry();
    });
  });
}
