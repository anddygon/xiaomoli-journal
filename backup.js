import { convertLegacyBackup, isLegacyBackup } from './legacy.js';
import {compressPhoto} from './photo-compress.js';

const format = 'xiaomoli-journal';
const version = 1;
const typeNames = new Set(['feed','sleep','pee','poop','med','supplement','temperature','vaccine','growth']);
const eventFields = ['uid','type','date','time','actor','detail','createdAt','updatedAt','startedAt','endedAt','endTime','note'];
const profileFields = ['babyName','birthDate','birthTime','sex','birthWeight','birthLength','birthHead'];
const catalogFields = ['uid','type','item','dose','unit'];
const photoLimit = 350 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownFields = (value,fields) => Object.fromEntries(fields.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
const fail = message => { throw new Error(message); };

function copyEvent(event) {
  return {...ownFields(event,eventFields),extra:{...event.extra}};
}

async function encodePhoto(blob) {
  const data = new Uint8Array(await blob.arrayBuffer());
  let raw = '';
  for (let pos=0; pos<data.length; pos+=8192) raw+=String.fromCharCode(...data.subarray(pos,pos+8192));
  return {type:'image/jpeg',data:btoa(raw)};
}

// Records stream into the file one at a time; avoid keeping all photos as
// both byte arrays and expanded base64 JS strings on an iPhone.
export async function makeBackup(snapshot, exportedAt=new Date()) {
  const parts = [JSON.stringify({format,version,exportedAt:exportedAt.toISOString(),
    profile:ownFields(snapshot.profile,profileFields),catalog:snapshot.catalog.map(t=>ownFields(t,catalogFields))}).slice(0,-1),',"events":['];
  for (const [position, value] of snapshot.events.entries()) {
    const event = copyEvent(value);
    if (event.extra.photo instanceof Blob) {
      const uploaded = event.extra.photo;
      const blob = uploaded.size > photoLimit || uploaded.type !== 'image/jpeg' ? (await compressPhoto(uploaded)).blob : uploaded;
      event.extra.photo = await encodePhoto(blob);
    }
    if (position) parts.push(',');
    parts.push(new Blob([JSON.stringify(event)]));
  }
  parts.push(']}');
  return new Blob(parts,{type:'application/json'});
}

function decodePhoto(picture) {
  if (!isObject(picture) || picture.type !== 'image/jpeg' || typeof picture.data !== 'string' ||
      !picture.data.length || picture.data.length>Math.ceil(photoLimit/3)*4) fail('备份中的照片格式或大小异常。');
  let raw;
  try {raw = atob(picture.data);} catch { fail('备份中的照片数据损坏。'); }
  if (raw.length<4 || raw.length>photoLimit || raw.charCodeAt(0)!==255 || raw.charCodeAt(1)!==216 ||
      raw.charCodeAt(raw.length-2)!==255 || raw.charCodeAt(raw.length-1)!==217) fail('备份中的 JPEG 照片不完整。');
  return new Blob([Uint8Array.from(raw,c=>c.charCodeAt(0))],{type:'image/jpeg'});
}

function checkUid(key) {
  if (typeof key!=='string' || !key || key.length>128 || !/^[a-zA-Z0-9_.:-]+$/.test(key)) fail('备份缺少有效的记录标识。');
}
function validDate(value) {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d=new Date(value+'T12:00:00Z');
  return Number.isFinite(+d) && d.toISOString().slice(0,10)===value;
}
const validTime = value=> typeof value==='string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export async function readBackup(file) {
  let input;
  try {input=JSON.parse(await file.text());} catch {fail('无法读取备份，请选择小茉莉日记导出的 JSON 文件。');}
  if (isLegacyBackup(input)) return convertLegacyBackup(input);
  if (input?.format!==format || input.version!==version) fail('这个文件不是可恢复的小茉莉日记备份。');
  if (!Array.isArray(input.events) || !Array.isArray(input.catalog) || !isObject(input.profile)) fail('备份结构不完整。');
  const seen = new Set();
  const profile = ownFields(input.profile,profileFields);
  if (Object.values(profile).some(x=>!['string','number'].includes(typeof x) || String(x).length>256)) fail('备份中的宝宝资料格式异常。');
  if (profile.birthDate && !validDate(profile.birthDate)) fail('备份中的出生日期无效。');
  const catalog = input.catalog.map(value=>{
    if (!isObject(value) || !['med','supplement'].includes(value.type) || typeof value.item!=='string' || !value.item.trim()) fail('备份中的常用项目格式异常。');
    checkUid(value.uid);
    if (['item','dose','unit'].some(k=>value[k]!=null && (typeof value[k]!=='string' || value[k].length>1000))) fail('备份中的常用项目内容异常。');
    return ownFields(value,catalogFields);
  });
  let photoCount=0;
  const events=input.events.map(value=>{
    if (!isObject(value) || !typeNames.has(value.type) || !validDate(value.date) || !validTime(value.time) ||
        !isObject(value.extra) || Object.hasOwn(value.extra,'__proto__')) fail('备份中的记录类型、日期或内容无效。');
    checkUid(value.uid);
    if (seen.has(value.uid)) fail('备份中有重复记录标识。');
    seen.add(value.uid);
    if (['startedAt','endedAt'].some(k=>value[k]!=null && (!Number.isSafeInteger(value[k]) || value[k]<0))) fail('备份中的计时时间无效。');
    if (value.startedAt != null && value.endedAt != null && value.endedAt < value.startedAt) fail('备份中的结束时间早于开始时间。');
    const event=copyEvent(value);
    if (event.extra.photo!=null) {
      if (value.type!=='poop') fail('备份中的照片归属异常。');
      event.extra.photo=decodePhoto(event.extra.photo);
      photoCount++;
    }
    return event;
  });
  return {events,catalog,profile,photoCount};
}

export function setupBackup({journal,refresh,notify}) {
  const byId=id=>document.getElementById(id);
  const output=byId('backupStatus'),file=byId('backupFile'),dialog=byId('restoreDialog');
  const exportButton=byId('exportBackup'),choose=byId('chooseBackup'),confirm=byId('confirmRestore'),cancel=byId('cancelRestore');
  let pending, scope, busy=false;
  function setBusy(flag){
    busy=flag;
    for (const b of [exportButton,choose,confirm,cancel]) b.disabled=flag;
  }
  exportButton.onclick=async()=>{
    if(busy)return;
    setBusy(true);output.textContent='正在准备备份…';
    try {
      const snapshot=await journal.load(), blob=await makeBackup(snapshot),url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;
      a.download='小茉莉日记-'+new Date().toISOString().slice(0,10)+'.json';
      document.body.append(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),60000);
      output.textContent='已生成备份，含 '+snapshot.events.length+' 条记录。请将文件存到安全的位置。';
    } catch(error) {output.textContent='导出失败。'+error.message;}
    finally{setBusy(false);}
  };
  choose.onclick=()=>file.click();
  file.onchange=async()=>{
    const selected=file.files[0];file.value='';
    if(!selected || busy)return;
    setBusy(true);output.textContent='正在读取备份…';
    try {
      scope=(await journal.context()).scope;
      pending=await readBackup(selected);
      byId('restoreDetail').textContent='文件中有 '+pending.events.length+' 条记录、'+pending.photoCount+' 张照片、'+pending.catalog.length+' 个常用项目。';
      dialog.showModal();output.textContent='';
    } catch(error) {pending=null;output.textContent=error.message;}
    finally{setBusy(false);}
  };
  cancel.onclick=()=>dialog.close();
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.addEventListener('close',()=>{pending=null;});
  confirm.onclick=async()=>{
    if(!pending || busy)return;
    setBusy(true);
    try {
      const {added,skipped}=await journal.importBackup(pending,scope);
      dialog.close();
      await refresh();
      output.textContent='已恢复，新增 '+added+' 项，跳过 '+skipped+' 项。';
      notify('备份恢复完成');
    } catch(error) {dialog.close();output.textContent='恢复失败。'+error.message;}
    finally{setBusy(false);}
  };
}
