import test from 'node:test';
import assert from 'node:assert/strict';
import {githubMock} from './github-fixture.mjs';
import {createGitFamilyRemote,generateFamilyKey,redeemGitInvite} from '../git-family-remote.js';
const options=(github,key,initialize=false)=>({repo:'parents/private',token:'github_pat_fake_finegrained',key,initialize,fetcher:github.fetcher});
const secretDoc=(n='sensitive-key')=>({kind:'event',key:n,deleted:false,mutationId:'operation-'+n,
  value:{type:'poop',detail:'private health information',extra:{}}});

test('私有仓库与写权限验证、家庭密钥确认、密钥和记录不出现在请求明文',async()=>{
  const github=githubMock(),key=generateFamilyKey();
  assert.match(key,/^[\w-]{43}$/);
  await assert.rejects(createGitFamilyRemote({...options(github,key),repo:'../repo'}),{code:'repo'});
  await assert.rejects(createGitFamilyRemote({...options(github,key),token:'ghp_classic'}),{code:'token'});
  github.settings.private=false;
  await assert.rejects(createGitFamilyRemote(options(github,key,true)),{code:'privacy'});
  assert.equal(github.files.size,0);github.settings.private=true;
  await assert.rejects(createGitFamilyRemote(options(github,key)),{code:'uninitialized'});
  await createGitFamilyRemote(options(github,key,true));assert.equal(github.files.size,1);
  const marker=github.files.values().next().value;
  await assert.rejects(createGitFamilyRemote(options(github,generateFamilyKey(),true)),{code:'decrypt'});
  assert.equal(github.files.values().next().value,marker);
  github.settings.write=false;
  await assert.rejects(createGitFamilyRemote(options(github,key)),{code:'permission'});
  github.settings.write=true;
  const remote=await createGitFamilyRemote(options(github,key));
  const doc=secretDoc();const op=await remote.write(doc);
  const stored=Buffer.from(github.blobs.get(op.sha),'base64');
  for(const x of [doc.key,doc.value.detail,key,'爸爸',doc.mutationId]){
    assert.ok(!stored.includes(Buffer.from(x)));assert.ok(!JSON.stringify(github.calls).includes(x));
  }
  assert.deepEqual(await remote.read(op.id,op.sha),doc);
  github.settings.private=false;
  await assert.rejects(remote.write(secretDoc('after-visibility-change')),{code:'privacy'});
  assert.equal(github.files.size,2);
});

test('并发写不同日记与同一条 CAS、墓碑、丢失响应、加密文件重放与照片',async()=>{
  const gh=githubMock(),key=generateFamilyKey();
  const a=await createGitFamilyRemote(options(gh,key,true)),b=await createGitFamilyRemote(options(gh,key));
  const one=secretDoc('one'),two=secretDoc('two');
  const jpg=Buffer.alloc(350*1024);jpg[0]=255;jpg[1]=216;jpg[2]=255;
  one.value.extra.photo=new Blob([jpg],{type:'image/jpeg'});two.value.extra.photo=jpg.toString('base64');
  gh.settings.race=true;
  const [first,second]=await Promise.all([a.write(one),b.write(two)]);
  gh.settings.truncate=true;
  assert.deepEqual(new Set((await a.list()).map(x=>x.sha)),new Set([first.sha,second.sha]));
  assert.deepEqual(Buffer.from(await (await b.read(first.id,first.sha)).value.extra.photo.arrayBuffer()),jpg);
  assert.equal((await a.read(second.id,second.sha)).value.extra.photo,two.value.extra.photo);
  await assert.rejects(b.read(first.id,second.sha),{code:'decrypt'});
  assert.equal(await a.idFor(two.kind,two.key),second.id);
  const update=await Promise.allSettled([a.write({...one,mutationId:'m1'},first.sha),b.write({...one,mutationId:'m2'},first.sha)]);
  assert.equal(update.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(update.find(r=>r.status==='rejected').reason.code,'conflict');
  const prev=update.find(r=>r.status==='fulfilled').value;
  const tombstone={...one,deleted:true,value:null,mutationId:'remove'};
  gh.settings.dropped=true;
  await assert.rejects(a.write(tombstone,prev.sha),TypeError);
  const fresh=(await b.list()).find(x=>x.id===prev.id);
  assert.deepEqual(await b.read(fresh.id,fresh.sha),tombstone);
  await assert.rejects(a.write(tombstone,prev.sha),{code:'conflict'});
  const restored=await b.write(one,fresh.sha);assert.notEqual(restored.sha,first.sha);
});


test('两台设备 ECDH 配对、重放和取消；邀请和历史文件均不含长期家庭密钥',async()=>{
  const gh=githubMock(),key=generateFamilyKey();
  const first=await createGitFamilyRemote({...options(gh,key,true),intervalMs:5});
  const now=Date.now();
  const invite=await first.createInvite();
  assert.notEqual(invite.secret,key);assert.ok(Date.parse(invite.expiresAt)-now>=29*60000);
  const join=()=>redeemGitInvite({...options(gh,key),secret:invite.secret,intervalMs:5});
  const both=await Promise.allSettled([join(),join()]);
  assert.deepEqual(both.filter(v=>v.status==='fulfilled').map(v=>v.value),[{key}]);
  assert.equal(both.filter(v=>v.status==='rejected').length,1);
  await assert.rejects(join(),{code:'used'});
  for(const body of gh.blobs.values()){
    assert.ok(!Buffer.from(body,'base64').includes(key));assert.ok(!Buffer.from(body,'base64').includes(invite.secret));
  }
  assert.ok(!JSON.stringify(gh.calls).includes(invite.secret));assert.ok(!JSON.stringify(gh.calls).includes(key));
  const revoked=await first.createInvite();await first.stopInvites();
  await assert.rejects(redeemGitInvite({...options(gh,key),secret:revoked.secret,intervalMs:5}),{code:'used'});
  const late=await first.createInvite();
  const realNow=Date.now;
  try{
    Date.now=()=>realNow()+30*60000+100;
    await assert.rejects(redeemGitInvite({...options(gh,key),secret:late.secret,intervalMs:5}),{code:'expired'});
  }finally{
    Date.now=realNow;
    await first.stopInvites();
  }
});
