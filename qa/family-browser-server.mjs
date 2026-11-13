/* Loopback-only test server with synthetic state, never backed by a GitHub account or network. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {githubMock} from './github-fixture.mjs';

const source=resolve(process.env.QA_STATIC_DIR || process.argv[2] || '.');
const selfDir=fileURLToPath(new URL('./',import.meta.url));
const prefix='/fixture-api',repo='/repos/parents/private';
const households=new Map();
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.mjs':'text/javascript','.png':'image/png','.webp':'image/webp','.webmanifest':'application/manifest+json','.json':'application/json'};

async function handle(req,res) {
  const u=new URL(req.url,'http://localhost');
  const path=u.pathname;
  const session=req.headers['x-qa-household'] || u.searchParams.get('instance') || '';
  if(session && !/^[a-z0-9]{3,32}$/.test(session))throw Error('Invalid synthetic household id');
  if(session && !households.has(session))households.set(session,githubMock());
  const gh=households.get(session);
  const reply=(status,type,text)=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store'});res.end(text);};
  if(path.startsWith(prefix+repo)){
    if(!['Bearer github_pat_fixture_mom','Bearer github_pat_fixture_dad'].includes(req.headers.authorization))return reply(401,'application/json','{}');
    const chunks=[];for await(const part of req)chunks.push(part);
    const body=Buffer.concat(chunks).toString()||undefined;
    const out=await gh.fetcher('https://api.github.com'+path.slice(prefix.length)+u.search,{method:req.method,credentials:'omit',redirect:'error',headers:{Authorization:req.headers.authorization},body});
    return reply(out.status,'application/json',await out.text());
  }
  if(path.startsWith(prefix))return reply(404,'text/plain','unknown test route');
  if(path==='/qa-scenario.html'||path==='/')return reply(200,'text/html',await readFile(join(selfDir,'family-browser.html')));
  if(path==='/qa-check'){
    // Fail the test if any written file in this in-memory repository contains plaintext notes.
    const plaintext=[...gh.blobs.values()].some(b64=>Buffer.from(b64,'base64').includes('合成离线照片'));
    return reply(200,'application/json',JSON.stringify({writes:gh.files.size,plaintext}));
  }
  const device=path.match(/^\/qa-phone-[ab]-[a-z0-9]+\//)?.[0];
  if(!device)return reply(404,'text/plain','unknown preview');
  const filename=path.slice(device.length)||'index.html';
  if(!/^[\w.-]+$/.test(filename)||filename.startsWith('.'))return reply(404,'text/plain','unknown asset');
  let bytes=await readFile(join(source,filename));
  if(filename==='index.html'){
    // Only test copies intercept GitHub. A request made while this device is offline must fail locally.
    const bootstrap='<script src="./fixture-network.js"></script>';
    return reply(200,'text/html',bytes.toString().replace('<head>','<head>'+bootstrap));
  }
  reply(200,mime[extname(filename)]||'application/octet-stream',bytes);
}
const server=createServer((req,res)=>{
  if(/^\/qa-phone-[ab]-[a-z0-9]+\/fixture-network\.js$/.test(req.url)){
    res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(`
      const originalFetch=window.fetch.bind(window);
      window.fetch=(...args)=>{
        const url=new URL(args[0],location.href);
        if(url.origin==='https://api.github.com'){
          if(sessionStorage.getItem('qa-offline:'+location.pathname)==='yes')return Promise.reject(new TypeError('Synthetic offline device'));
          const init={...args[1],headers:{...args[1].headers,'x-qa-household':location.pathname.split('-').pop().split('/')[0]}};
          return originalFetch('/fixture-api'+url.pathname+url.search,init);
        }
        return originalFetch(...args);
      };
    `);return;
  }
  handle(req,res).catch(e=>{if(!res.headersSent)res.writeHead(e.code==='ENOENT'?404:500);res.end('test server error');console.error(e.message);});
});
server.listen(Number(process.env.PORT||process.argv[3]||0),'127.0.0.1',()=>console.log('QA_PORT='+server.address().port));
