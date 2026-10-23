import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { loopingGif } from './gif.js';
import { storedVideoMime } from './video.js';
export const ORIGIN = 'intelboard://app';
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-src 'self' blob: https://www.youtube-nocookie.com; worker-src 'self' blob:; font-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const mime = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.wasm':'application/wasm', '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf', '.bcmap':'application/octet-stream' };
export async function fileResponse(file, type, request, extra = {}) {
  const info = await stat(file); if (!info.isFile()) return new Response('Not found',{status:404});
  const headers = { 'Content-Type':type, 'X-Content-Type-Options':'nosniff', 'Accept-Ranges':'bytes', ...extra };
  let start=0,end=info.size-1,status=200;
  const range=request.headers.get('range');
  if(range) {
    const match=range.match(/^bytes=(\d*)-(\d*)$/);
    if(!match || (!match[1]&&!match[2])) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}});
    if(match[1]) { start=Number(match[1]); end=match[2]?Math.min(Number(match[2]),end):end; }
    else start=Math.max(0,info.size-Number(match[2]));
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${info.size}`}});
    status=206; headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length']=String(Math.max(0,end-start+1));
  if(request.method==='HEAD'||info.size===0) return new Response(null,{status,headers});
  return new Response(Readable.toWeb(createReadStream(file,{start,end})),{status,headers});
}
export function createProtocol(service, dist) {
  return async request => {
    try {
      const url=new URL(request.url);
      if(url.origin!==ORIGIN && !(url.protocol==='intelboard:'&&url.host==='app')) return new Response('Forbidden',{status:403});
      if(request.initiatorOrigin && ![ORIGIN, 'null'].includes(request.initiatorOrigin)) return new Response('Forbidden',{status:403});
      if(!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
      const asset=url.pathname.match(/^\/api\/assets\/([0-9a-f-]{36})$/);
      if(asset) {
        const a=service.assets.get(asset[1]); if(!a) return new Response('File not found',{status:404});
        const original=path.join(service.assets.folder,a.id);
        if(url.searchParams.get('preview')==='1'&&a.thumbnail) return fileResponse(path.join(service.assets.folder,a.thumbnail),'image/webp',request);
        if(url.searchParams.get('animated')==='1'&&a.mime==='image/gif'&&a.thumbnail) {
          try { return new Response(loopingGif(await readFile(original)),{headers:{'Content-Type':'image/gif','X-Content-Type-Options':'nosniff'}}); }
          catch { return fileResponse(path.join(service.assets.folder,a.thumbnail),'image/webp',request); }
        }
        // Readers consume bytes through fetch. Active attachments are never rendered as documents.
        const type=a.thumbnail?a.mime:await storedVideoMime(original,a)||'application/octet-stream';
        return fileResponse(original,type,request,{'Content-Security-Policy':"default-src 'none'; sandbox",'Content-Disposition':'inline'});
      }
      const decoded=decodeURIComponent(url.pathname);
      if(decoded.includes('\\')||decoded.includes('\0')) return new Response('Forbidden',{status:403});
      const file=path.resolve(dist,'.'+decoded);
      if(!file.startsWith(path.resolve(dist)+path.sep)) return new Response('Forbidden',{status:403});
      return await fileResponse(file,mime[path.extname(file)]||'application/octet-stream',request,{'Content-Security-Policy':CSP});
    } catch { return new Response('File unavailable',{status:404}); }
  };
}
