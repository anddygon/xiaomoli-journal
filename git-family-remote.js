const baseDir = 'xiaomoli-family-v1';
const marker = baseDir + '/family.bin';
const recordsDir = baseDir + '/records';
const markerValue = 'xiaomoli-private-family-v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal:true});
const photoLimit = 350 * 1024;
const plainLimit = 640 * 1024;
const idPattern = /^[0-9a-f]{64}$/;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const kinds = new Set(['event','profile','catalog']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, message, status = 0) {
  return Object.assign(new Error(message), {code, status});
}
function to64(bytes) {
  let result = '';
  for (let i=0;i<bytes.length;i+=8192) result+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(result);
}
function from64(text) {
  return Uint8Array.from(atob(text), char=>char.charCodeAt(0));
}
export function generateFamilyKey() {
  return to64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function importKeys(text) {
  if (!/^[\w-]{43}$/.test(text)) throw fail('key','家庭密钥格式不正确，请重新粘贴。');
  const bytes=from64(text.replace(/-/g,'+').replace(/_/g,'/'));
  const source=await crypto.subtle.importKey('raw',bytes,'HKDF',false,['deriveKey']);
  bytes.fill(0);
  const derive=(label,algorithm,uses)=>crypto.subtle.deriveKey({
    name:'HKDF',hash:'SHA-256',salt:encoder.encode(markerValue),info:encoder.encode(label)
  },source,algorithm,false,uses);
  return Promise.all([derive('documents',{name:'AES-GCM',length:256},['encrypt','decrypt']),
    derive('names',{name:'HMAC',hash:'SHA-256',length:256},['sign'])]);
}
function checkIdentity(kind,key) {
  if (!kinds.has(kind) || typeof key!=='string' || !key.length || key.length>512 || (kind==='profile' && key!=='baby')) {
    throw fail('invalid','记录标识无效。');
  }
}
function checkJpegString(value){
  if(!value || value.length>4*Math.ceil(photoLimit/3) || value.length%4!==0 ||
    !value.startsWith('/9j/') || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
    value.length/4*3 - (value.endsWith('==')?2:value.endsWith('=')?1:0)>photoLimit){
    throw fail('photo','家庭照片格式或体积异常。');
  }
}
async function freezeRecord(record) {
  checkIdentity(record.kind,record.key);
  if(typeof record.deleted!=='boolean' || (record.deleted ? record.value!=null : !isObject(record.value))) {
    throw fail('invalid','家庭记录格式无效。');
  }
  const photo=record.value?.extra?.photo;
  if(photo==null)return record;
  if(typeof photo==='string' && record.kind==='event' && record.value.type==='poop'){
    checkJpegString(photo);return record;
  }
  if(record.kind!=='event' || record.value.type!=='poop' || !(photo instanceof Blob) || photo.type!=='image/jpeg' || photo.size>photoLimit) {
    throw fail('photo','照片需为压缩后的 JPEG，且小于等于 350 KiB。');
  }
  const packed={jpeg:to64(new Uint8Array(await photo.arrayBuffer()))};
  return {...record,value:{...record.value,extra:{...record.value.extra,photo:packed}}};
}
function thawRecord(record) {
  const photo=record?.value?.extra?.photo;
  if(photo==null)return record;
  if(typeof photo==='string' && record.kind==='event' && record.value.type==='poop'){
    checkJpegString(photo);return record;
  }
  if(record.kind!=='event' || record.value.type!=='poop' || typeof photo.jpeg!=='string' || photo.jpeg.length>4*Math.ceil(photoLimit/3)) {
    throw fail('photo','家庭照片格式无效。');
  }
  const bytes=from64(photo.jpeg);
  if(bytes.length>photoLimit)throw fail('photo','家庭照片太大。');
  return {...record,value:{...record.value,extra:{...record.value.extra,photo:new Blob([bytes],{type:'image/jpeg'})}}};
}

async function connectRepository({repo,token,fetcher=globalThis.fetch.bind(globalThis)}){
  if(typeof repo!=='string' || !/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(repo) || /\/\.{1,2}$/.test(repo)) {
    throw fail('repo','请填写 GitHub 私有仓库，格式为 用户名/仓库名。');
  }
  if(typeof token!=='string' || !/^github_pat_[A-Za-z0-9_]+$/.test(token)) {
    throw fail('token','请使用仅授权这个私有仓库的细粒度访问令牌。');
  }
  const api='https://api.github.com/repos/'+repo;
  async function request(path,body,method) {
    if(body!==undefined)verifyPrivate(await request(''));
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),20000);
    try {
      const headers={Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'};
      const init={method:method??(body===undefined?'GET':'PUT'),headers,credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal};
      if(body!==undefined){headers['Content-Type']='application/json';init.body=JSON.stringify(body);}
      const res=await fetcher(api+path,init);
      if(!res.ok){
        const limited=res.status===429 || (res.status===403 && (res.headers.has('retry-after') || res.headers.get('x-ratelimit-remaining')==='0'));
        if(limited)throw fail('rate_limit','GitHub 请求暂时受限，记录已保存在本机，请稍后同步。',res.status);
        if(res.status===401 || res.status===403)throw fail('permission','请核对令牌有效期以及这个私有仓库的 Contents 读写权限。',res.status);
        if(res.status===409 || res.status===422)throw fail('conflict','家庭记录已更新，请重新同步。',res.status);
        throw fail('repository',res.status===404?'找不到仓库或文件，请检查仓库名和令牌权限。':'GitHub 暂时无法处理请求。',res.status);
      }
      return await res.json();
    }finally{clearTimeout(timer);}
  }
  function verifyPrivate(info){
    if(info.private!==true || String(info.full_name).toLowerCase()!==repo.toLowerCase())throw fail('privacy','仅可连接你指定的私有仓库。');
    if(info.permissions?.push===false || info.archived || info.disabled)throw fail('permission','这个令牌对应的账号无法写入该仓库。');
  }
  const info=await request('');
  verifyPrivate(info);
  if(typeof info.default_branch!=='string' || !info.default_branch)throw fail('branch','找不到仓库默认分支。');
  const branch=info.default_branch;
  const branchPath=branch.split('/').map(encodeURIComponent).join('/');
  const contents=path=>'/contents/'+path+'?ref='+encodeURIComponent(branch);
  async function currentFile(path) {
    try{return await request(contents(path));}catch(e){if(e.status===404)return null;throw e;}
  }
  return {request,currentFile,branch,branchPath};
}
async function claimInviteFile(repository,path,sha,content){
  return repository.request('/contents/'+path,{message:'Update encrypted family invitation',branch:repository.branch,sha,content});
}
const inviteDir=baseDir+'/pairing';
const inviteLifetime=30*60*1000;
const asUrl64=bytes=>to64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const urlBytes=value=>from64(value.replace(/-/g,'+').replace(/_/g,'/'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function assertNotExpired(state){
  if(!Number.isSafeInteger(state?.until) || state.until<=Date.now())throw fail('expired','邀请已过期，请让另一位家长重新生成。');
}
async function inviteVault(repo,secret){
  if(typeof secret!=='string' || !/^[\w-]{43}$/.test(secret))throw fail('invite','邀请链接不完整。');
  const [aes,naming]=await importKeys(secret);
  const id=asUrl64(new Uint8Array(await crypto.subtle.sign('HMAC',naming,encoder.encode('invite file'))));
  const path=inviteDir+'/'+id+'.bin';
  const aad=encoder.encode('Jasmine pairing v1\n'+repo.toLowerCase()+'\n'+path);
  async function seal(value){
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const box=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},aes,encoder.encode(JSON.stringify(value))));
    const out=new Uint8Array(12+box.length);out.set(iv);out.set(box,12);return to64(out);
  }
  async function open(file){
    if(!file)throw fail('invite','找不到邀请，请检查链接。');
    try{
      if(!shaPattern.test(file.sha) || file.content?.length>10000)throw Error();
      const packed=from64(file.content);
      return JSON.parse(decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:packed.slice(0,12),additionalData:aad},aes,packed.slice(12))));
    }catch{throw fail('invite','邀请链接或邀请文件无效。');}
  }
  return {path,seal,open};
}
async function pairCipher(pair,peerPublic,requestId){
  const peer=await crypto.subtle.importKey('raw',urlBytes(peerPublic),{name:'ECDH',namedCurve:'P-256'},false,[]);
  const secret=await crypto.subtle.deriveBits({name:'ECDH',public:peer},pair.privateKey,256);
  const source=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode(requestId),info:encoder.encode('xiaomoli-device-pair-v1')},
    source,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
const newPair=()=>crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
const sharePublic=async pair=>asUrl64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)));
export async function redeemGitInvite({repo,token,secret,fetcher,intervalMs=3000}){
  const vault=await inviteVault(repo,secret);
  const repository=await connectRepository({repo,token,fetcher});
  const initial=await repository.currentFile(vault.path);
  const offered=await vault.open(initial);assertNotExpired(offered);
  if(offered.stage!=='open')throw fail('used','邀请已被领取或撤销，请重新生成。');
  const pair=await newPair(),requestId=generateFamilyKey();
  const claim={stage:'claimed',until:offered.until,requestId,peer:await sharePublic(pair)};
  try{
    await claimInviteFile(repository,vault.path,initial.sha,await vault.seal(claim));
  }catch(e){
    if(e.code!=='conflict' && !(e instanceof TypeError) && e.name!=='AbortError')throw e;
    const actual=await vault.open(await repository.currentFile(vault.path));
    if(actual.requestId!==requestId)throw fail('used','邀请已被领取，请重新生成。');
  }
  const waitUntil=Math.min(offered.until,Date.now()+120000);
  for(;;){
    assertNotExpired(offered);
    if(Date.now()>=waitUntil)throw fail('pair_timeout','两分钟内没有配对成功。请两部手机保持日记打开，重新生成邀请后再试。');
    const file=await repository.currentFile(vault.path);
    const state=await vault.open(file);assertNotExpired(state);
    if(state.requestId!==requestId || !['claimed','ready'].includes(state.stage))throw fail('used','邀请已失效，请重新生成。');
    if(state.stage==='ready'){
      const aes=await pairCipher(pair,state.issuer,requestId);
      const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:urlBytes(state.iv),additionalData:encoder.encode(repo.toLowerCase())},aes,urlBytes(state.box));
      const key=asUrl64(new Uint8Array(plain));
      if(!/^[\w-]{43}$/.test(key))throw fail('invite','配对验证失败。');
      try{
        await claimInviteFile(repository,vault.path,file.sha,await vault.seal({stage:'used',until:state.until,requestId}));
      }catch(e){
        if(e.code!=='conflict' && !(e instanceof TypeError) && e.name!=='AbortError')throw e;
        const final=await vault.open(await repository.currentFile(vault.path));
        if(final.stage!=='used' || final.requestId!==requestId)throw e;
      }
      return {key};
    }
    await pause(intervalMs);
  }
}

export async function createGitFamilyRemote({repo,token,key,initialize=false,fetcher,intervalMs=3000}) {
  const repository=await connectRepository({repo,token,fetcher});
  const {request,currentFile,branch,branchPath}=repository;
  const [encryption,naming]=await importKeys(key);
  function cipherParams(path,iv) {
    return {name:'AES-GCM',iv,additionalData:encoder.encode(markerValue+'\n'+repo.toLowerCase()+'\n'+path)};
  }
  async function encrypt(path,value) {
    const plain=encoder.encode(JSON.stringify(value));
    if(plain.length>plainLimit)throw fail('size','单条日记过大，请缩小照片或文字后重试。');
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const data=new Uint8Array(await crypto.subtle.encrypt(cipherParams(path,iv),encryption,plain));
    const packed=new Uint8Array(1+iv.length+data.length);
    packed[0]=1;packed.set(iv,1);packed.set(data,13);
    return to64(packed);
  }
  async function decrypt(path,blob) {
    try {
      if(blob.encoding!=='base64' || typeof blob.content!=='string' || blob.content.length>(plainLimit+100)*1.5)throw new Error();
      const b=from64(blob.content);
      if(b.length<29 || b[0]!==1)throw new Error();
      return JSON.parse(decoder.decode(await crypto.subtle.decrypt(cipherParams(path,b.subarray(1,13)),encryption,b.subarray(13))));
    }catch{throw fail('decrypt','家庭密钥不匹配或同步文件已损坏。请向另一位家长核对密钥。');}
  }
  async function writeFile(path,value,expectedSha) {
    if(expectedSha!==null && !shaPattern.test(expectedSha))throw fail('revision','远端版本无效。');
    const content=await encrypt(path,value);
    const body={message:'Update encrypted family journal',content,branch};
    if(expectedSha)body.sha=expectedSha;
    for(let i=0;i<3;i++){
      try{
        const result=await request('/contents/'+path,body);
        if(!shaPattern.test(result.content?.sha))throw fail('revision','未收到远端文件版本。');
        return result.content.sha;
      }catch(e){
        if(e.code!=='conflict' || i===2)throw e;
        // The Contents API may race on the branch even for unrelated paths.
        const current=await currentFile(path);
        if((current?.sha??null)!==expectedSha)throw e;
      }
    }
  }
  async function checkWritePermission(){
    // A detached tree containing the existing encrypted marker adds no commit or file.
    // This verifies the token's Contents:write permission even on a read-only first sync.
    await request('/git/trees',{tree:[{path:'family.bin',mode:'100644',type:'blob',sha:markerFile.sha}]},'POST');
  }
  function checkMarker(value){if(value!==markerValue)throw fail('decrypt','家庭验证文件无法识别。');}
  let markerFile=await currentFile(marker);
  if(!markerFile){
    if(!initialize)throw fail('uninitialized','这个仓库尚未创建家庭，请先在第一台手机创建。');
    try{await writeFile(marker,markerValue,null);}catch(e){
      if(e.code!=='conflict')throw e;
      markerFile=await currentFile(marker);
      if(!markerFile)throw e;
    }
  }
  if(markerFile){
    checkMarker(await decrypt(marker,markerFile));
    await checkWritePermission();
  }
  async function idFor(kind,recordKey) {
    checkIdentity(kind,recordKey);
    const signature=new Uint8Array(await crypto.subtle.sign('HMAC',naming,encoder.encode(JSON.stringify([kind,recordKey]))));
    return Array.from(signature,b=>b.toString(16).padStart(2,'0')).join('');
  }
  const pathFor=id=>recordsDir+'/'+id.slice(0,2)+'/'+id+'.bin';
  async function tree(sha,recursive=false) {
    if(!shaPattern.test(sha))throw fail('tree','家庭索引版本无效。');
    const data=await request('/git/trees/'+sha+(recursive?'?recursive=1':''));
    if(!Array.isArray(data.tree))throw fail('tree','无法读取家庭索引。');
    return data;
  }
  function directory(entries,name){
    return entries.find(item=>item.path===name && item.mode==='040000' && item.type==='tree')?.sha;
  }
  function entryFile(item,path){
    const match=/^([a-f0-9]{2})\/([a-f0-9]{64})\.bin$/.exec(path);
    return match && match[2].startsWith(match[1]) && item.type==='blob' && item.mode==='100644' && shaPattern.test(item.sha)
      ?{id:match[2],sha:item.sha}:null;
  }
  let previousSignature=null,previousList=[];
  async function list(){
    const ref=await request('/git/ref/heads/'+branchPath);
    const head=ref.object?.sha;
    if(!shaPattern.test(head))throw fail('branch','无法读取默认分支版本。');
    if(head===previousSignature)return previousList.slice();
    const commit=await request('/git/commits/'+head);
    const root=await tree(commit.tree?.sha);
    const baseSha=directory(root.tree,baseDir);
    if(!baseSha || root.truncated)throw fail('tree','家庭目录缺失或目录列表不完整。');
    const base=await tree(baseSha);
    if(base.truncated)throw fail('tree','家庭目录列表不完整。');
    const dirSha=directory(base.tree,'records');
    const result=[];
    if(dirSha){
      const recursive=await tree(dirSha,true);
      if(!recursive.truncated){
        for(const row of recursive.tree){const file=entryFile(row,row.path);if(file)result.push(file);}
      }else{
        const top=await tree(dirSha);
        if(top.truncated)throw fail('tree','家庭索引太大，读取未完成。');
        for(const shard of top.tree.filter(v=>/^[a-f0-9]{2}$/.test(v.path) && v.type==='tree')){
          const group=await tree(shard.sha);
          if(group.truncated)throw fail('tree','家庭索引太大，读取未完成。');
          for(const row of group.tree){const file=entryFile(row,shard.path+'/'+row.path);if(file)result.push(file);}
        }
      }
    }
    previousSignature=head;previousList=result;
    return result.slice();
  }
  async function read(id,sha){
    if(!idPattern.test(id) || !shaPattern.test(sha))throw fail('revision','家庭文件版本无效。');
    const blob=await request('/git/blobs/'+sha);
    const doc=thawRecord(await decrypt(pathFor(id),blob));
    if(!doc || await idFor(doc.kind,doc.key)!==id || typeof doc.deleted!=='boolean' ||
      (doc.deleted?doc.value!=null:!isObject(doc.value)))throw fail('invalid','家庭记录与文件标识不匹配。');
    return doc;
  }
  async function write(doc,expectedSha=null) {
    const id=await idFor(doc.kind,doc.key);
    const sha=await writeFile(pathFor(id),await freezeRecord(doc),expectedSha);
    return {id,sha};
  }
  let activeInvite;
  async function stopInvites(){
    const session=activeInvite;
    if(!session)return;
    session.stopped=true;activeInvite=null;
    if(session.timer){clearTimeout(session.timer);session.wake();}
    if(!session.vault)return;
    const {path,seal,open}=session.vault;
    const file=await currentFile(path);
    if(!file)return;
    const state=await open(file);
    if(state.stage==='open' || state.stage==='claimed'){
      try{await claimInviteFile(repository,path,file.sha,await seal({stage:'revoked',until:state.until}));}
      catch(e){if(e.code!=='conflict')throw e;}
    }
  }
  async function createInvite(){
    await stopInvites();
    const secret=generateFamilyKey(),until=Date.now()+inviteLifetime;
    const vault=await inviteVault(repo,secret),session={stopped:false,vault};activeInvite=session;
    const doc={stage:'open',until};
    await request('/contents/'+vault.path,{message:'Create encrypted family invitation',branch,content:await vault.seal(doc)});
    async function respond(){
      while(!session.stopped && Date.now()<until){
        await new Promise(resolve=>{session.wake=resolve;session.timer=setTimeout(resolve,intervalMs);});
        session.timer=null;
        if(session.stopped || Date.now()>=until)return;
        try{
          const file=await currentFile(vault.path);
          const state=await vault.open(file);
          if(state.until!==until || !['open','claimed'].includes(state.stage))return;
          if(state.stage==='open')continue;
          const pair=await newPair();
          const aes=await pairCipher(pair,state.peer,state.requestId);
          const iv=crypto.getRandomValues(new Uint8Array(12));
          const sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(repo.toLowerCase())},aes,urlBytes(key));
          if(session.stopped || Date.now()>=until)return;
          await claimInviteFile(repository,vault.path,file.sha,await vault.seal({stage:'ready',until,requestId:state.requestId,
            issuer:await sharePublic(pair),iv:asUrl64(iv),box:asUrl64(new Uint8Array(sealed))}));
          return;
        }catch(e){
          if(e.code==='permission' || e.code==='invite' || e.code==='decrypt')return;
        }
      }
    }
    void respond();
    return {repo,secret,expiresAt:new Date(until).toISOString()};
  }
  return {idFor,list,read,write,createInvite,stopInvites};
}
