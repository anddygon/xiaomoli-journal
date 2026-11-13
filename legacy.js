import { compressPhoto } from './photo-compress.js';

const types = {喂奶:'feed',睡眠:'sleep',尿尿:'pee',便便:'poop',用药:'med',营养品:'supplement',体温:'temperature',疫苗:'vaccine',成长测量:'growth'};
const profileKeys = {name:'babyName',birth:'birthDate',sex:'sex',birthTime:'birthTime',weight:'birthWeight',length:'birthLength',head:'birthHead'};
const detailFields = ['method','side','duration','volume','amount','color','texture','dose','unit','note','weight','length','head','value','site'];
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value+'T12:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0,10) === value;
}

function readProfile(old) {
  const profile = {};
  for (const [from,to] of Object.entries(profileKeys)) {
    const value = old?.[from];
    if (value === '' || value == null) continue;
    if (!['number','string'].includes(typeof value) || String(value).length > 256) throw Error('旧版宝宝档案中的资料格式有误。');
    profile[to] = from === 'sex' && value === '未填写' ? '暂不填写' : String(value);
  }
  if (profile.birthDate && !validDate(profile.birthDate)) throw Error('旧版宝宝出生日期无效。');
  return profile;
}

async function oldPhoto(data) {
  const match = typeof data === 'string' && /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(data);
  if (!match) throw Error('旧版照片格式有误。');
  let bytes;
  try { bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0)); }
  catch { throw Error('旧版照片数据不完整。'); }
  const mime = match[1].toLowerCase();
  const photo = new Blob([bytes],{type:mime});
  if (mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 &&
      bytes.at(-2) === 255 && bytes.at(-1) === 217 && photo.size <= 350*1024) return photo;
  return (await compressPhoto(photo)).blob;
}

// The first demo only saved the displayed text for each entry.
function demoDetails(type, detail) {
  const words = detail.split(' · ').map(word => word.trim());
  if (type === 'feed') {
    const method = words.find(s => ['母乳','奶粉','混合喂养'].includes(s));
    const side = words.find(s => ['左侧','右侧','双侧'].includes(s));
    const volume = words.find(s => /^\d+(\.\d+)?\s*ml$/i.test(s));
    return {...method && {method}, ...side && {side}, ...volume && {volume:String(parseFloat(volume))}};
  }
  if (['med','supplement'].includes(type)) return {item:words[0],dose:words.slice(1).join(' · ')};
  if (type === 'poop' && words.length === 1 && ['糊状','成形','稀便','水样'].includes(words[0])) return {texture:words[0]};
  return {};
}

function timerFields(old, extra) {
  const at = new Date(old.date+'T'+old.time+':00').getTime();
  const duration = extra.duration !== '' && extra.duration != null ? Number(extra.duration) : NaN;
  if (old.startedAt == null) {
    if (old.active === true) return {startedAt:at};
    return Number.isFinite(duration) && duration >= 0 ? {startedAt:at,endedAt:at+duration*60000} : {};
  }
  const start = old.startedAt;
  if (!Number.isSafeInteger(start) || start < 0) throw Error('旧版计时的开始时间有误。');
  if (old.active === true) return {startedAt:start};
  let end = old.endedAt;
  if (end == null && typeof old.endTime === 'string' && timePattern.test(old.endTime)) {
    const date = new Date(start);
    const [hour,minute] = old.endTime.split(':').map(Number);
    const beforeStartMinute = hour*60+minute < date.getHours()*60+date.getMinutes();
    date.setHours(hour,minute,0,0);
    if (beforeStartMinute) date.setDate(date.getDate()+1);
    end = Math.max(start,+date);
  }
  if (end == null && Number.isFinite(duration)) end = start+duration*60000;
  if (end == null) return {};
  if (!Number.isSafeInteger(end) || end < start) throw Error('旧版计时的结束时间有误。');
  return {startedAt:start,endedAt:end};
}

export function isLegacyBackup(data) {
  return isObject(data) && !('format' in data) && [undefined,2].includes(data.version) &&
    Array.isArray(data.records) && isObject(data.profile);
}

export async function convertLegacyBackup(input) {
  if (!isLegacyBackup(input)) throw Error('旧版小茉莉日记备份格式有误。');
  const events = [], catalog = new Map(), ids = new Set();
  let photoCount = 0;
  for (const old of input.records) {
    if (!isObject(old) || !Object.hasOwn(types,old.type) || !validDate(old.date) ||
        !timePattern.test(old.time) || typeof old.id !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(old.id) || ids.has(old.id)) throw Error('旧版记录的类型、标识、日期或时间有误。');
    ids.add(old.id);
    const type = types[old.type], detail = String(old.detail ?? '');
    const extra = demoDetails(type,detail);
    const data = old.data;
    if (data != null && !isObject(data)) throw Error('旧版记录详情有误。');
    if (data) {
      for (const key of detailFields) {
        if (data[key] != null) extra[key] = String(data[key]);
      }
      if (data.name != null) extra.item = String(data.name);
    }
    if (old.photo) {
      if (type !== 'poop') throw Error('旧版照片所属记录类型有误。');
      extra.photo = await oldPhoto(old.photo);
      photoCount++;
    }
    if ((type === 'med' || type === 'supplement') && data?.remember && extra.item?.trim()) {
      const key = type+'\0'+extra.item.trim();
      catalog.set(key,{uid:old.id,type,item:extra.item.trim(),dose:extra.dose || '',unit:extra.unit || ''});
    }
    const timer = ['feed','sleep'].includes(type) ? timerFields(old,extra) : {};
    if (timer.endedAt != null && extra.duration == null) extra.duration = String(Math.round((timer.endedAt-timer.startedAt)/60000));
    const event = {uid:old.id,type,date:old.date,time:old.time,actor:String(old.actor || ''),detail,extra,...timer};
    for (const field of ['createdAt','updatedAt','endTime']) if (typeof old[field] === 'string') event[field] = old[field];
    events.push(event);
  }
  return {events,catalog:[...catalog.values()],profile:readProfile(input.profile),photoCount};
}

async function readOldRecords(idb) {
  // Opening an absent database normally creates it. Abort that upgrade on browsers
  // without indexedDB.databases(), leaving no empty legacy store behind.
  return new Promise((resolve,reject) => {
    const open = idb.open('xiaomoli-v2');
    let absent = false;
    open.onupgradeneeded = event => {if (event.oldVersion === 0) {absent=true;open.transaction.abort();}};
    open.onerror = () => absent ? resolve([]) : reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('records')) {db.close();reject(Error('旧版记录表不可读。'));return;}
      const tx = db.transaction('records','readonly');
      const rows = tx.objectStore('records').getAll();
      tx.oncomplete = () => {db.close();resolve(rows.result);};
      tx.onabort = () => {db.close();reject(tx.error || Error('旧版日记读取中断。'));};
    };
  });
}

export async function migrateLegacyBrowser(journal) {
  // Older builds used origin-wide keys. Never guess which other GitHub Pages
  // project on a shared origin owns them.
  if (location.hostname.endsWith('.github.io') && !/^\/xiaomoli-journal(?:\/|$)/.test(location.pathname)) return;
  if (await journal.legacyImported()) return;
  const read = (key,fallback) => JSON.parse(localStorage.getItem(key) ?? fallback);
  const first = read('xiaomoli-demo-records','[]');
  if (!Array.isArray(first)) throw Error('旧版本机日记格式有误。');
  const latest = await readOldRecords(indexedDB);
  // A file from the first version could have been explicitly imported into v2.
  // Prefer the newer representation of the same record.
  const rows = new Map([...first,...latest].map(row => [row.id,row]));
  const profile = {...read('xiaomoli-demo-profile','{}'),...read('xiaomoli-profile','{}')};
  const data = await convertLegacyBackup({version:2,records:[...rows.values()],profile});
  return journal.finishLegacyImport(data,localStorage.getItem('xiaomoli-actor'));
}
