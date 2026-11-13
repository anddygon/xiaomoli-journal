import {createGitFamilyRemote, generateFamilyKey, redeemGitInvite} from './git-family-remote.js';
import {createGitSync} from './git-family-sync.js';

const byId = id => document.getElementById(id);
const repository = 'anddygon/xiaomoli-family-data';
const uidBytes = new TextEncoder();
const vaultName = 'xiaomoli-family-access:' + new URL('./',import.meta.url).pathname;
function request(req) {
  return new Promise((resolve,reject) => {req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
}
async function openVault() {
  const op=indexedDB.open(vaultName,1);
  op.onupgradeneeded=()=>op.result.createObjectStore('device');
  return request(op);
}
async function credential(db, config) {
  const tx=db.transaction('device',config===undefined?'readonly':'readwrite');
  const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('无法保存本机授权。'));});
  const store=tx.objectStore('device');
  const result= config===undefined ? await request(store.get('family')) : await request(store.put(config,'family'));
  await done;return result;
}
function parseInvite(input) {
  let url;
  try{url=new URL(input);}catch{throw Error('请输入完整的家庭邀请链接。');}
  const own=new URL('./',import.meta.url);
  if(url.origin!==own.origin || url.pathname!==own.pathname)throw Error('请使用本日记生成的邀请链接。');
  const hash=new URLSearchParams(url.hash.slice(1));
  const repo=hash.get('family'),secret=hash.get('join');
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo||'') || !/^[\w-]{43}$/.test(secret||''))throw Error('这条邀请链接不完整。');
  return {repo,secret};
}
async function familyId(repo,key) {
  const digest=await crypto.subtle.digest('SHA-256',uidBytes.encode(key));
  return repo.toLowerCase()+'/'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
function statusText(state){return state.message+(state.pending?' · '+state.pending+' 项待同步':'');}

export async function setupGitFamily({journal,refresh,notify}) {
  const panel=byId('gitFamily'),dialog=byId('gitSetup'),form=byId('gitSetupForm');
  const notice=byId('gitNotice'),status=byId('gitStatus'),issues=byId('gitConflicts');
  const token=byId('gitToken'),address=byId('gitRepo'),link=byId('gitLink'),recovery=byId('gitRecovery');
  const mode=byId('gitMode'),confirm=byId('gitConnect'),error=byId('gitError');
  const inviteBox=byId('gitInviteBox'),inviteResult=byId('gitInviteResult');
  let db,config,remote,engine,connecting,cycle=0,formBusy=false;
  let incoming=null;
  if(location.hash.startsWith('#family=')||location.hash.startsWith('#join=')){
    try{incoming=parseInvite(location.href);}catch(e){notify(e.message);}
    history.replaceState(null,'',location.pathname+location.search+'#profile');
    document.querySelector('[data-tab="profile"]').click();
  }
  const activate=byId('gitOpen'), syncNow=byId('gitNow'), invite=byId('gitInvite');
  function showStatus(state) {
    const text=statusText(state);status.textContent=text;notice.textContent=(config?.bound?'家庭日记 · ':'')+text;
    if(state.conflictCount)void showConflicts().catch(e=>notify(e.message));else issues.replaceChildren();
  }
  async function showConflicts(){
    if(!engine)return;
    const items=await engine.conflicts();issues.replaceChildren();
    for(const item of items){
      const row=document.createElement('div'),label=document.createElement('p');
      label.textContent='本机：'+item.localTitle+'　家庭：'+item.remoteTitle;row.append(label);
      for(const [choice,title] of [['local','保留本机'],['remote','保留家庭版本']]){
        const btn=document.createElement('button');btn.type='button';btn.textContent=title;
        btn.onclick=async()=>{try{await engine.resolveConflict(item.id,choice,item);await showConflicts();}catch(e){notify(e.message);}};row.append(btn);
      }
      issues.append(row);
    }
  }
  function renderControls(){
    activate.textContent=config?'连接设置':'启用家庭同步';
    syncNow.hidden=!config||config.paused;invite.hidden=!config?.bound||config.paused;
    const switchView=byId('gitSwitchView');switchView.hidden=!config?.bound;switchView.textContent=config?.paused?'回到家庭日记':'查看原来的本机日记';
    byId('gitShowRecovery').hidden=!config?.bound;
  }
  async function connect(){
    if(connecting)return connecting;
    const generation=++cycle;
    connecting=(async()=>{
      if(!config || config.paused)return;
      status.textContent='正在连接家庭仓库…';
      const candidate=await createGitFamilyRemote({repo:config.repo,token:config.token,key:config.key,initialize:config.initialize===true});
      if(generation!==cycle)return;
      const id=await familyId(config.repo,config.key);
      engine?.stop();remote=candidate;
      engine=createGitSync(journal,candidate,id,{onStatus:showStatus,onChange:()=>refresh(true)});
      await engine.start({includeLocal:config.includeLocal===true});
      config={...config,bound:true,initialize:false,includeLocal:false};
      await credential(db,config);await refresh(true);renderControls();
    })().finally(()=>{connecting=null;});
    return connecting;
  }
  function reportFailure(e){const detail=e?.message||'暂时无法连接家庭仓库。';status.textContent='本机可继续记录。'+detail;notice.textContent='仅存本机或待同步 · '+detail;}
  function updateMode(){
    const selected=mode.value;
    byId('gitLinkRow').hidden=selected!=='join';byId('gitRecoveryRow').hidden=selected!=='recover';
    byId('gitMergeRow').hidden=!!config?.bound;address.readOnly=!!config?.bound || selected==='join';
    link.required=selected==='join';recovery.required=selected==='recover';token.required=!config?.token;
    error.textContent='';
  }
  function openSetup(){
    if(formBusy)return;
    address.value=incoming?.repo||config?.repo||repository;token.value='';recovery.value='';link.value='';
    mode.value=config?.bound?'resume':incoming?'join':config?'resume':'create';
    mode.querySelector('[value="resume"]').hidden=!config;mode.disabled=!!config?.bound;
    if(incoming){const u=new URL('./',import.meta.url);u.hash=new URLSearchParams({family:incoming.repo,join:incoming.secret});link.value=u.href;}
    byId('gitMerge').checked=!!config?.includeLocal;updateMode();dialog.showModal();
  }
  mode.onchange=updateMode;link.oninput=()=>{try{address.value=parseInvite(link.value).repo;}catch{}};
  activate.onclick=openSetup;
  byId('gitCancel').onclick=()=>dialog.close();
  dialog.onclose=()=>{token.value='';recovery.value='';link.value='';};
  form.onsubmit=async(event)=>{
    event.preventDefault();if(formBusy)return;
    formBusy=true;confirm.disabled=true;error.textContent='正在验证家庭连接…';
    const choice=mode.value,original=config;
    try{
      if(connecting)await connecting.catch(()=>{});
      let repo=address.value.trim(),key=original?.key,pat=token.value.trim()||original?.token;
      if(!/^github_pat_[A-Za-z0-9_]+$/.test(pat||''))throw Error('请粘贴这个私有仓库的细粒度令牌。');
      if(choice==='join'){
        const input=parseInvite(link.value.trim());repo=input.repo;
        error.textContent='请保持两台手机的日记打开，正在等待另一台手机完成配对…';
        ({key}=await redeemGitInvite({repo,token:pat,secret:input.secret}));
      }else if(choice==='recover')key=recovery.value.trim();
      else if(choice==='create' && (!key||repo!==original?.repo||!original?.initialize))key=generateFamilyKey();
      if(!/^[\w-]{43}$/.test(key||''))throw Error('请核对家庭恢复密钥。');
      if(original?.bound && (key!==original.key||repo.toLowerCase()!==original.repo.toLowerCase()))throw Error('这台手机已经连接其他家庭。');
      // Save the generated key before the first network write, so an interrupted first setup is recoverable.
      config={repo,token:pat,key,initialize:choice==='create'||(choice==='resume'&&original?.initialize===true),bound:original?.bound===true,includeLocal:!original?.bound && byId('gitMerge').checked};
      await credential(db,config);renderControls();await connect();incoming=null;
      if(dialog.open)dialog.close();notify('已连接家庭日记');
    }catch(e){error.textContent=e.message;reportFailure(e);}finally{confirm.disabled=false;formBusy=false;}
  };
  syncNow.onclick=async()=>{try{if(engine)await engine.sync();else await connect();}catch(e){reportFailure(e);}};
  byId('gitSwitchView').onclick=async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{
      if(connecting)await connecting.catch(()=>{});
      const id=await familyId(config.repo,config.key);
      if(config.paused){
        await journal.bindGit(id,false);config={...config,paused:false};
        await credential(db,config);await refresh(true);await connect();
      }else{
        if(engine)await engine.disconnect();else await journal.unbindGit(id);
        engine=null;remote=null;config={...config,paused:true};
        await credential(db,config);await refresh(true);notice.textContent='仅存本机';status.textContent='正在查看原来的本机日记。家庭记录保留在家庭日记中。';
      }
    }catch(e){reportFailure(e);}finally{button.disabled=false;renderControls();}
  };
  invite.onclick=async()=>{
    invite.disabled=true;
    try{
      if(!remote)await connect();const result=await remote.createInvite();
      const url=new URL('./',import.meta.url);url.hash=new URLSearchParams({family:result.repo,join:result.secret});
      inviteResult.value=url.href;inviteBox.showModal();
    }catch(e){reportFailure(e);}finally{invite.disabled=false;}
  };
  byId('gitCopyInvite').onclick=async()=>{
    try{await navigator.clipboard.writeText(inviteResult.value);byId('gitCopyHint').textContent='已复制，可发给另一位家长。';}
    catch{inviteResult.focus();inviteResult.select();byId('gitCopyHint').textContent='长按已选中的链接即可复制。';}
  };
  byId('gitCloseInvite').onclick=()=>inviteBox.close();inviteBox.onclose=()=>{inviteResult.value='';byId('gitCopyHint').textContent='';remote?.stopInvites().catch(()=>{});};
  byId('gitShowRecovery').onclick=()=>{byId('gitKeyText').value=config.key;byId('gitKeyBox').showModal();};
  byId('gitKeyClose').onclick=()=>byId('gitKeyBox').close();byId('gitKeyBox').onclose=()=>{byId('gitKeyText').value='';};
  try{
    db=await openVault();config=await credential(db);renderControls();
    if(incoming&&!config?.bound)openSetup();
    if(config&&!config.paused){notice.textContent='家庭日记 · 正在检查同步';void connect().catch(reportFailure);}
    window.addEventListener('online',()=>{if(config&&!config.paused&&!engine)void connect().catch(reportFailure);});
    panel.hidden=false;
  }catch(e){status.textContent='无法读取本机家庭设置。'+e.message;activate.disabled=true;panel.hidden=false;}
}
