// Each local edit and its pending mutation are committed in a single IndexedDB
// transaction. Only encrypted files with new revisions need to be downloaded.
export function createGitSync(journal,remote,identity,{onStatus=()=>{},onChange=()=>{}}={}) {
  const scope='git/'+identity;
  let active=false,cycle=null,repeat=false,unsubscribe=null,poll=null,wakeup=null;
  let status={phase:'local',message:'尚未连接家庭',pending:0,conflictCount:0};
  function show(phase,message,states=[]) {
    status={phase,message,pending:states.filter(s=>s.mutationId&&!s.conflictSha).length,
      conflictCount:states.filter(s=>s.conflictSha).length};
    if(active)onStatus({...status});
    return {...status};
  }
  async function run() {
    if(!active)return;
    let changed=false;
    const states=await journal.gitStates(scope);
    if(globalThis.navigator?.onLine===false){show('offline','等待联网，记录已保存在本机',states);return;}
    show('syncing','正在同步',states);
    try {
      const listed=await remote.list(),byId=new Map();
      for(const state of states) {
        if(state.id)byId.set(state.id,state);
        else if(state.mutationId)byId.set(await remote.idFor(state.kind,state.docKey),state);
      }
      for(const {id,sha} of listed) {
        if(!active)return;
        const prior=byId.get(id);
        if(prior?.sha===sha || prior?.conflictSha===sha)continue;
        const doc=await remote.read(id,sha);
        if(!active)return;
        if(await journal.receiveGit(scope,id,sha,doc,prior?.sha??null,prior?.conflictSha??null))changed=true;
      }
      // Never recreate a file removed directly from the backing repository.
      // App deletes retain an encrypted tombstone and appear in the list.
      const ids=new Set(listed.map(v=>v.id));
      if(states.some(s=>s.sha && !ids.has(s.id)))throw Error('家庭仓库缺少已同步文件。请恢复仓库文件后重试。');
      const pending=await journal.gitStates(scope);
      for(const state of pending.filter(s=>s.mutationId&&!s.conflictSha)) {
        if(!active)return;
        const id=state.id || await remote.idFor(state.kind,state.docKey);
        const doc=await journal.prepareGit(scope,state,id);
        if(!doc || !active)continue;
        try {
          const result=await remote.write(doc,state.sha);
          if(active)await journal.ackGit(scope,state,doc.mutationId,id,result.sha);
        } catch(e) {
          if(e.code!=='conflict' && ![409,412].includes(e.status))throw e;
          // Read the winning immutable blob on the next cycle, never overwrite it.
          return 'race';
        }
      }
    } finally {if(changed && active)await onChange();}
    if(!active)return;
    const state=await journal.gitStates(scope);
    return show(state.some(s=>s.conflictSha)?'conflict':'synced',
      state.some(s=>s.conflictSha)?'有修改需要核对':state.some(s=>s.mutationId)?'有记录待上传':'已同步',state);
  }
  function sync(){
    if(!active)return Promise.resolve({...status});
    if(cycle){repeat=true;return cycle;}
    async function perform(){
      let races=0;
      do {
        repeat=false;
        if(await run()==='race') {
          if(++races>=3)throw Error('另一台设备正在更新，下次同步会再试。');
          repeat=true;
        }
      }while(active && repeat);
      return {...status};
    }
    const locks=globalThis.navigator?.locks;
    cycle=Promise.resolve().then(()=>locks?locks.request('xiaomoli-sync/'+identity,perform):perform())
      .catch(async e=>{
        let state=[];try{state=await journal.gitStates(scope);}catch{}
        const offline=globalThis.navigator?.onLine===false || e instanceof TypeError || e.name==='AbortError';
        return show(offline?'offline':'error',offline?'连接中断，记录已保存在本机':e.message,state);
      }).finally(()=>{cycle=null;});
    return cycle;
  }
  function schedule(){
    if(!active || wakeup || globalThis.document?.hidden)return;
    wakeup=setTimeout(()=>{wakeup=null;sync();},300);
  }
  function stop(){
    active=false;repeat=false;clearTimeout(wakeup);wakeup=null;clearInterval(poll);unsubscribe?.();
    globalThis.removeEventListener?.('online',schedule);
    globalThis.removeEventListener?.('offline',schedule);
    globalThis.document?.removeEventListener('visibilitychange',schedule);
  }
  return {
    async start({includeLocal=false}={}) {
      if(!active){
        await journal.bindGit(identity,includeLocal);
        active=true;unsubscribe=journal.subscribe(schedule);
        poll=setInterval(schedule,30000);
        globalThis.addEventListener?.('online',schedule);globalThis.addEventListener?.('offline',schedule);
        globalThis.document?.addEventListener('visibilitychange',schedule);
        await onChange();
      }
      return sync();
    },
    sync,stop,
    async disconnect(){
      stop();if(cycle)await cycle;
      await journal.unbindGit(identity);await onChange();
      status={phase:'local',message:'已断开，当前为本机日记',pending:0,conflictCount:0};onStatus({...status});
    },
    getStatus:()=>({...status}),
    conflicts:()=>journal.gitConflicts(scope),
    async resolveConflict(id,choice,seen){await journal.resolveGit(scope,id,choice,seen);await onChange();return sync();}
  };
}
