import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const digest=s=>createHash('sha1').update(s).digest('hex');
export function githubMock(){
  const files=new Map(),blobs=new Map(),trees=new Map(),commits=new Map(),calls=[];
  const settings={private:true,write:true,push:true,truncate:false,race:false,dropped:false};
  let head,version=0;
  function commit(){
    const root={};
    for(const [path,sha] of files){
      const bits=path.split('/');let dir=root;
      for(const name of bits.slice(0,-1))dir=dir[name]??={};
      dir[bits.at(-1)]=sha;
    }
    function build(dir){
      const items=Object.entries(dir).map(([path,v])=>typeof v==='string'?{path,type:'blob',mode:'100644',sha:v}:
        {path,type:'tree',mode:'040000',sha:build(v)});
      const sha=digest(JSON.stringify(items));trees.set(sha,items);return sha;
    }
    const sha=build(root);
    head=digest(String(++version));commits.set(head,{tree:{sha}});
  }
  commit();
  const fetcher=async(url,init)=>{
    assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');
    const u=new URL(url);assert.equal(u.origin,'https://api.github.com');
    assert.ok(u.pathname.startsWith('/repos/parents/private'));
    const path=u.pathname.slice('/repos/parents/private'.length);
    assert.ok(['Bearer github_pat_fake_finegrained','Bearer github_pat_fixture_mom','Bearer github_pat_fixture_dad'].includes(init.headers.Authorization));
    const body=init.body?JSON.parse(init.body):null;
    calls.push({path,method:init.method,body});
    const json=(v,status=200)=>Response.json(v,{status});
    if(!path)return json({private:settings.private,full_name:'parents/private',default_branch:'main',permissions:{push:settings.push}});
    if(path.startsWith('/contents/')){
      const name=path.slice(10),existing=files.get(name);
      if(init.method==='GET')return existing?json({sha:existing,encoding:'base64',content:blobs.get(existing)}):json({},404);
      assert.equal(init.method,'PUT');
      if(!settings.write)return json({},403);
      if(settings.race){settings.race=false;return json({},409);}
      if(existing!==body.sha)return json({},existing?422:409);
      assert.equal(body.branch,'main');
      const sha=digest(Buffer.from(body.content,'base64'));files.set(name,sha);blobs.set(sha,body.content);commit();
      if(settings.dropped){settings.dropped=false;throw new TypeError('lost reply');}
      return json({content:{sha}},existing?200:201);
    }
    if(path==='/git/trees' && init.method==='POST')return json({},settings.write?201:403);
    if(path==='/git/ref/heads/main')return json({object:{sha:head}});
    if(path.startsWith('/git/commits/'))return json(commits.get(path.split('/').pop()));
    if(path.startsWith('/git/trees/')){
      const base=trees.get(path.split('/').pop());
      if(!u.search)return json({tree:base,truncated:false});
      const tree=[];
      function flatten(list,prefix){
        for(const i of list){
          tree.push({...i,path:prefix+i.path});if(i.type==='tree')flatten(trees.get(i.sha),prefix+i.path+'/');
        }
      }
      flatten(base,'');return json({tree:settings.truncate?tree.slice(0,1):tree,truncated:settings.truncate});
    }
    if(path.startsWith('/git/blobs/')){
      const sha=path.split('/').pop();
      return json({sha,encoding:'base64',content:blobs.get(sha)});
    }
    assert.fail('Unexpected route '+path);
  };
  return {files,blobs,calls,settings,fetcher};
}
