const WORKSPACE = 'workspace';
const DOCS = 'documents';
const META = 'metadata';
const STORES = [DOCS, META];
const uuid = () => crypto.randomUUID();
const compound = (scope, kind, key) => [scope, kind, key];
const stamp = () => new Date().toISOString();
const timerTypeName = value => value?.type==='feed'?'喂奶':'睡眠';
const running = e => e && ['feed','sleep'].includes(e.type) && Number.isFinite(e.startedAt) && e.endedAt == null;
const request = r => new Promise((resolve,reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const get = (tx,s,k) => request(tx.objectStore(s).get(k));
const put = (tx,s,v) => request(tx.objectStore(s).put(v));
const scoped = (tx,store,scope) => request(tx.objectStore(store).index('scope').getAll(scope));
// Persist the photo bytes directly. Some WebKit data stores reject native Blob
// references. Read the Blob before opening a transaction so it stays active.
async function packPhoto(value) {
  const photo=value?.extra?.photo;
  if(!(photo instanceof Blob))return value;
  const stored={encoding:'journal-photo-bytes',type:photo.type,bytes:await photo.arrayBuffer()};
  return {...value,extra:{...value.extra,photo:stored}};
}
function unpackPhoto(value) {
  const photo=value?.extra?.photo;
  if(photo?.encoding!=='journal-photo-bytes' || !(photo.bytes instanceof ArrayBuffer))return value;
  const blob=new Blob([photo.bytes],{type:photo.type || 'image/jpeg'});
  return {...value,extra:{...value.extra,photo:blob}};
}
async function packBackup(source) {
  const events=[];
  for(const entry of source.events || [])events.push(await packPhoto(entry));
  return {...source,events};
}
async function packDoc(doc) {
  return doc?.value?.extra?.photo ? {...doc,value:await packPhoto(doc.value)} : doc;
}
function unpackDoc(doc) {
  return doc?.value?.extra?.photo ? {...doc,value:unpackPhoto(doc.value)} : doc;
}
function productValue(record) {
  const v = {...record};
  for (const key of ['id','uid','key','status','revision','_scope','serverRevision']) delete v[key];
  return v;
}
function present(row) {
  if (!row || row.deleted) return null;
  return {...row.value, uid:row.key, id:row.key, revision:row.localRevision, _scope:row.scope};
}
async function transaction(db,mode,fn) {
  const tx = db.transaction(STORES,mode);
  const done = new Promise((resolve,reject) => {
    tx.oncomplete=resolve;
    tx.onabort=()=>reject(tx.error || new Error('日记保存未完成'));
  });
  try { const result=await fn(tx);await done;return result; }
  catch(error){ try{tx.abort();}catch{} await done.catch(()=>{});throw error; }
}
function ensureScope(ws, expected) {
  if (expected !== ws.scope) throw new Error('日记已切换，请重新打开这条记录');
}
async function guardTimer(tx,scope,key,value) {
  if (!running(value)) return;
  const store = tx.objectStore(DOCS);
  const exists = await request(store.index('timer').get([scope,value.type]));
  if (exists && exists.key !== key) throw new Error('已有一条'+timerTypeName(value)+'计时正在进行');
}
function asRow(scope,kind,key,value,previous,deleted=false) {
  const row = {scope,kind,key,value:deleted?null:value,deleted,
    localRevision:(previous?.localRevision || 0)+1};
  if(kind==='event' && !deleted && running(value))row.timerType=value.type;
  return row;
}
const gitScope = identity => 'git/'+identity;
const gitPrefix = scope => 'git-state/'+encodeURIComponent(scope)+'/';
const gitKey = (scope,kind,id) => gitPrefix(scope)+kind+'/'+id;
const conflictKey = key => 'git-conflict/'+key;
const copyForRemote = row => ({kind:row.kind,key:row.key,deleted:row.deleted,value:row.value});
function versionTitle(doc) {
  if(doc.deleted)return '已删除';
  const v=doc.value || {};
  if(doc.kind==='profile')return [v.babyName,v.birthDate,v.sex].filter(Boolean).join(' · ') || '宝宝档案';
  if(doc.kind==='catalog')return [v.item,v.dose,v.unit].filter(Boolean).join(' · ');
  return [v.date,v.time,v.detail || v.extra?.item,v.extra?.note,v.actor].filter(Boolean).join(' · ') || '照护记录';
}
async function gitStates(tx,scope){
  const prefix=gitPrefix(scope);
  return request(tx.objectStore(META).getAll(IDBKeyRange.bound(prefix,prefix+'\uffff',false,true)));
}
async function markGitDirty(tx,ws,row) {
  if(!ws.scope.startsWith('git/'))return;
  const key=gitKey(ws.scope,row.kind,row.key);
  const prior=await get(tx,META,key);
  await put(tx,META,{...prior,key,kind:row.kind,docKey:row.key,sha:prior?.sha??null,
    mutationId:uuid(),localRevision:row.localRevision});
}
async function journalWrite(tx,ws,kind,key,value,action='put') {
  const k=compound(ws.scope,kind,key);
  const previous=await get(tx,DOCS,k);
  if(previous?.deleted && action==='put')throw new Error('这条记录已删除');
  if(kind==='event' && action!=='delete')await guardTimer(tx,ws.scope,key,value);
  const row=asRow(ws.scope,kind,key,value,previous,action==='delete');
  await put(tx,DOCS,row);
  await markGitDirty(tx,ws,row);
  return row;
}
function upgrade(db) {
  const docs=db.createObjectStore(DOCS,{keyPath:['scope','kind','key']});
  docs.createIndex('scope','scope');
  docs.createIndex('timer',['scope','timerType']);
  db.createObjectStore(META,{keyPath:'key'}).put({key:WORKSPACE,scope:'local/device',localScope:'local/device'});
}
export async function openJournal(databaseName='xiaomoli-pages:' + new URL('./',import.meta.url).pathname) {
  if(!globalThis.indexedDB)throw new Error('此浏览器无法使用本机记录存储');
  const opening=indexedDB.open(databaseName,1);
  opening.onupgradeneeded=()=>upgrade(opening.result);
  const db=await new Promise((resolve,reject)=>{
    let blocked=false;
    opening.onblocked=()=>{blocked=true;reject(new Error('请关闭其他打开的小茉莉日记页面，然后刷新'));};
    opening.onerror=()=>reject(opening.error);
    opening.onsuccess=()=>{if(blocked)opening.result.close();else resolve(opening.result);};
  });
  db.onversionchange=()=>db.close();
  const listeners=new Set();
  const change=()=>listeners.forEach(fn=>fn());
  const read=fn=>transaction(db,'readonly',fn);
  const write=async(fn,notify=true)=>{const result=await transaction(db,'readwrite',fn);if(notify)change();return result;};
  const current=tx=>get(tx,META,WORKSPACE);
  const eventKey=e=>e.uid || e.id;
  async function merge(tx,ws,source) {
    let added=0,skipped=0;
    const all=await scoped(tx,DOCS,ws.scope);
    const templates=new Set(all.filter(x=>x.kind==='catalog' && !x.deleted).map(x=>x.value.type+'\0'+x.value.item));
    for(const [kind,values] of [['event',source.events||[]],['catalog',source.catalog||[]],['profile',source.profile && Object.keys(productValue(source.profile)).length?[source.profile]:[]]]){
      for(const value of values){
        const key=kind==='profile'?'baby':value.uid;
        if(!key || typeof key!=='string')throw new Error('备份缺少有效记录标识');
        const data=productValue(value);
        if(kind==='profile' && !Object.values(data).some(v=>v!=='' && v!=null))continue;
        const template=kind==='catalog'?data.type+'\0'+data.item:null;
        if((await get(tx,DOCS,compound(ws.scope,kind,key))) || (template && templates.has(template))){skipped++;continue;}
        await journalWrite(tx,ws,kind,key,data);
        if(template)templates.add(template);
        added++;
      }
    }
    return {added,skipped};
  }
  async function snapshot(tx,scope) {
    const rows=await scoped(tx,DOCS,scope);
    return {events:rows.filter(r=>r.kind==='event'&&!r.deleted).map(present),
      catalog:rows.filter(r=>r.kind==='catalog'&&!r.deleted).map(present),
      profile:present(rows.find(r=>r.kind==='profile'))||{}};
  }
  const api={
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    close(){listeners.clear();db.close();},
    load(){return read(async tx=>{
      const ws=await current(tx);
      const [data,prefs]=await Promise.all([snapshot(tx,ws.scope),get(tx,META,'prefs/'+ws.localScope)]);
      return {...data,events:data.events.map(unpackPhoto),scope:ws.scope,preferences:prefs?{parent:prefs.parent}:{}};
    });},
    async saveEvent(e,template){
      e=await packPhoto(e);
      return write(async tx=>{
      const ws=await current(tx);
      if(e._scope)ensureScope(ws,e._scope);
      const key=eventKey(e)||uuid();
      const existing=await get(tx,DOCS,compound(ws.scope,'event',key));
      if(e.id!=null && (!existing || existing.deleted || existing.localRevision!==e.revision))throw new Error('这条记录已更新或移除，请重新打开');
      const now=stamp();
      const value={...productValue(e),createdAt:existing?.value?.createdAt || e.createdAt || now,updatedAt:now};
      const row=await journalWrite(tx,ws,'event',key,value);
      if(template?.item){
        const items=await scoped(tx,DOCS,ws.scope);
        const prior=items.find(r=>r.kind==='catalog'&&!r.deleted && r.value.type===template.type && r.value.item===template.item.trim());
        await journalWrite(tx,ws,'catalog',prior?.key || uuid(),{...productValue(template),item:template.item.trim()});
      }
      return unpackPhoto(present(row));
    });},
    removeEvent(id,revision,expectedScope){return write(async tx=>{
      const ws=await current(tx);if(expectedScope)ensureScope(ws,expectedScope);
      const row=await get(tx,DOCS,compound(ws.scope,'event',id));
      if(!row || row.deleted)throw new Error('这条记录已删除');
      if(revision!=null && row.localRevision!==revision)throw new Error('这条记录已更新，请重新打开');
      const removed=present(row);
      const tombstone=await journalWrite(tx,ws,'event',id,null,'delete');
      removed.undoRevision=tombstone.localRevision;
      return unpackPhoto(removed);
    });},
    async restoreEvent(removed){
      removed=await packPhoto(removed);
      return write(async tx=>{
      const ws=await current(tx);ensureScope(ws,removed._scope);
      const key=eventKey(removed),row=await get(tx,DOCS,compound(ws.scope,'event',key));
      if(!row?.deleted || row.localRevision!==removed.undoRevision)throw new Error('这条记录已再次变动，无法撤销');
      const value=productValue(removed);delete value.undoRevision;
      return unpackPhoto(present(await journalWrite(tx,ws,'event',key,value,'restore')));
    });},
    saveProfile(profile){return write(async tx=>{
      const ws=await current(tx);if(profile._scope)ensureScope(ws,profile._scope);
      const prev=await get(tx,DOCS,compound(ws.scope,'profile','baby'));
      if(profile.revision!=null && (prev?.localRevision??0)!==profile.revision)throw new Error('宝宝资料已更新，请重新编辑');
      return present(await journalWrite(tx,ws,'profile','baby',productValue(profile)));
    });},
    savePreferences(patch){return write(async tx=>{
      const ws=await current(tx),key='prefs/'+ws.localScope;
      const value={...await get(tx,META,key), ...patch,key};
      await put(tx,META,value);return value;
    });},
    async bindGit(identity,includeLocal=false){
      if(typeof identity!=='string' || !identity || identity.length>512)throw Error('家庭标识无效。');
      return write(async tx=>{
        const ws=await current(tx),scope=gitScope(identity);
        if(ws.scope!==ws.localScope && ws.scope!==scope)throw Error('请先断开目前的家庭，再连接另一个家庭。');
        if(ws.scope===scope)return ws;
        const selected={...ws,scope};
        if(includeLocal===true)await merge(tx,selected,await snapshot(tx,ws.localScope));
        await put(tx,META,selected);
        return selected;
      });
    },
    unbindGit(identity){return write(async tx=>{
      const ws=await current(tx);ensureScope(ws,gitScope(identity));
      const local={...ws,scope:ws.localScope};
      await put(tx,META,local);return local;
    });},
    gitStates(scope){return read(async tx=>{
      ensureScope(await current(tx),scope);return gitStates(tx,scope);
    });},
    prepareGit(scope,entry,id){return write(async tx=>{
      ensureScope(await current(tx),scope);
      const state=await get(tx,META,entry.key);
      if(!state?.mutationId || state.mutationId!==entry.mutationId || state.sha!==entry.sha || state.conflictSha)return null;
      const row=await get(tx,DOCS,compound(scope,state.kind,state.docKey));
      if(!row)return null;
      await put(tx,META,{...state,id,inflight:state.mutationId});
      return unpackDoc({...copyForRemote(row),mutationId:state.mutationId});
    },false);},
    ackGit(scope,entry,mutationId,id,sha){return write(async tx=>{
      ensureScope(await current(tx),scope);
      const state=await get(tx,META,entry.key);
      if(!state || state.sha!==entry.sha || state.conflictSha)return false;
      if(state.inflight!==mutationId && state.mutationId!==mutationId)return false;
      await put(tx,META,{...state,id,sha,inflight:null,
        mutationId:state.mutationId===mutationId?null:state.mutationId});
      return true;
    },false);},
    async receiveGit(scope,id,sha,doc,expectedSha,expectedConflict){
      doc=await packDoc(doc);
      return write(async tx=>{
      ensureScope(await current(tx),scope);
      const key=gitKey(scope,doc.kind,doc.key), previous=await get(tx,META,key);
      if(previous?.sha===sha || previous?.conflictSha===sha)return false;
      if((previous?.sha??null)!==expectedSha || (previous?.conflictSha??null)!==expectedConflict)return false;
      if(previous?.mutationId && doc.mutationId && [previous.inflight,previous.mutationId].includes(doc.mutationId)){
        await put(tx,META,{...previous,id,sha,inflight:null,conflictSha:null,
          mutationId:previous.mutationId===doc.mutationId?null:previous.mutationId});
        await request(tx.objectStore(META).delete(conflictKey(key)));
        return false;
      }
      if(previous?.mutationId){
        await put(tx,META,{...previous,id,conflictSha:sha});
        await put(tx,META,{key:conflictKey(key),doc});
        return true;
      }
      const docKey=compound(scope,doc.kind,doc.key), old=await get(tx,DOCS,docKey);
      const row=asRow(scope,doc.kind,doc.key,doc.value,old,doc.deleted);
      await put(tx,DOCS,row);
      await put(tx,META,{key,kind:doc.kind,docKey:doc.key,id,sha,localRevision:row.localRevision,mutationId:null});
      return true;
    },false);},
    gitConflicts(scope){return read(async tx=>{
      ensureScope(await current(tx),scope);
      const states=await gitStates(tx,scope),out=[];
      for(const s of states.filter(s=>s.conflictSha)){
        const local=await get(tx,DOCS,compound(scope,s.kind,s.docKey));
        const remote=await get(tx,META,conflictKey(s.key));
        out.push({id:s.key,kind:s.kind,key:s.docKey,localTitle:versionTitle(local),remoteTitle:versionTitle(remote.doc),
          sha:s.conflictSha,localRevision:local.localRevision});
      }
      return out;
    });},
    resolveGit(scope,key,choice,seen){return write(async tx=>{
      ensureScope(await current(tx),scope);
      if(!key.startsWith(gitPrefix(scope)) || !['local','remote'].includes(choice))throw Error('无效的同步选择。');
      const state=await get(tx,META,key);
      if(!state?.conflictSha)throw Error('此条冲突已经处理。');
      const docKey=compound(scope,state.kind,state.docKey);
      const currentRow=await get(tx,DOCS,docKey);
      if(seen && (seen.sha!==state.conflictSha || seen.localRevision!==currentRow.localRevision))throw Error('记录又有修改，请重新核对。');
      let revision=currentRow.localRevision;
      if(choice==='remote'){
        const {doc}=await get(tx,META,conflictKey(key));
        const row=asRow(scope,doc.kind,doc.key,doc.value,currentRow,doc.deleted);
        await put(tx,DOCS,row);revision=row.localRevision;
      }
      await put(tx,META,{...state,sha:state.conflictSha,conflictSha:null,inflight:null,localRevision:revision,
        mutationId:choice==='local'?uuid():null});
      await request(tx.objectStore(META).delete(conflictKey(key)));
    });},
    legacyImported(){return read(async tx=>!!(await get(tx,META,'legacy:github-v2')));},
    async finishLegacyImport(source,actor){
      source=await packBackup(source);
      return write(async tx=>{
      const marker='legacy:github-v2';
      if(await get(tx,META,marker))return {added:0,skipped:0};
      const ws=await current(tx);
      // An earlier failed migration can retry after this device joined a family.
      // Keep those old entries in the original local scope until explicitly merged.
      const result=await merge(tx,{...ws,scope:ws.localScope},source);
      const prefsKey='prefs/'+ws.localScope;
      if(['爸爸','妈妈'].includes(actor) && !(await get(tx,META,prefsKey))){
        await put(tx,META,{key:prefsKey,parent:actor});
      }
      await put(tx,META,{key:marker});
      return result;
    });},
    async importBackup(source,expectedScope){
      source=await packBackup(source);
      return write(async tx=>{
      const ws=await current(tx);if(expectedScope)ensureScope(ws,expectedScope);
      return merge(tx,ws,source);
    });},
    context(){return read(current);}
  };
  return api;
}
