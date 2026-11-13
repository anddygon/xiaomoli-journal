import { openJournal } from './storage.js';
import { createEntryController, finishNursing, switchNursingSide, sideTimes } from './entry.js';
import { icon, hydrateIcons } from './icons.js';
import { migrateLegacyBrowser } from './legacy.js';
import { setupGitFamily } from './git-family-ui.js';
import { setupBackup } from './backup.js';

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const names = {feed:'喂奶',sleep:'睡眠',pee:'尿尿',poop:'便便',med:'用药',supplement:'营养品',temperature:'体温',vaccine:'疫苗',growth:'成长测量'};
const healthTypes = new Set(['med','supplement','temperature','vaccine','growth']);
const profileFields = ['babyName','birthDate','birthTime','sex','birthWeight','birthLength','birthHead'];
const pages = ['home','timeline','health','profile'];
const pad = n => String(n).padStart(2,'0');
const dateKey = d => d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
const timeKey = d => pad(d.getHours()) + ':' + pad(d.getMinutes());
const dayDate = key => new Date(key + 'T12:00:00');
const dayFormat = (d,options) => d.toLocaleDateString('zh-CN',options);
const duration = mins => mins < 60 ? mins + ' 分钟' : Math.floor(mins/60) + ' 小时' + (mins%60 ? ' ' + mins%60 + ' 分钟' : '');
const active = e => ['feed','sleep'].includes(e.type) && Number.isFinite(e.startedAt) && e.endedAt == null;
const eventStamp = e => new Date(e.date+'T'+e.time+':00').getTime();
const sorted = list => [...list].sort((a,b)=>b.date.localeCompare(a.date) || b.time.localeCompare(a.time) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || String(b.uid ?? b.id).localeCompare(String(a.uid ?? a.id)));
const elapsed = e => Math.max(0,Math.floor(((e.endedAt ?? Date.now()) - e.startedAt)/60000));
const putText = (id,text) => {const el=document.getElementById(id);if(el)el.textContent=text;};
function elem(tag,cls,text) {
  const el = document.createElement(tag);
  if(cls) el.className=cls;
  if(text!=null) el.textContent=text;
  return el;
}
function glyph(type) { const el=elem('span','glyph'); el.innerHTML=icon(type);return el; }
function action(label,cls,handle) {
  const b=elem('button',cls,label);b.type='button';b.onclick=handle;return b;
}
let journal, entry, state={events:[],profile:{},catalog:[],preferences:{}};
let actor='爸爸', day=dateKey(new Date()), todayKey=day, currentTab='home';
let toastTimer, viewerUrl, quickBusy=false, loadGeneration=0;
const appRoot = new URL('./', import.meta.url).pathname;
const storeName = 'xiaomoli-pages:' + appRoot;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(storeName) : null;
function notify(message,undo) {
  clearTimeout(toastTimer);
  const t=$('#toast'); t.replaceChildren(document.createTextNode(message)); t.classList.add('show');
  if(undo)t.append(action('撤销','undo',async event=>{
    const button=event.currentTarget;
    button.disabled=true;
    try{ await undo(); }catch(e){ notify(e.message); }
  }));
  toastTimer=setTimeout(()=>{
    t.classList.remove('show');
    t.replaceChildren();
  },undo?10000:4000);
}
function viewPhoto(blob) {
  if (!(blob instanceof Blob)) {notify('未找到这张照片');return;}
  if(viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl=URL.createObjectURL(blob);
  $('#photoFull').src=viewerUrl;$('#photoDialog').showModal();
}
$('#photoClose').onclick=()=>$('#photoDialog').close();
$('#photoDialog').onclose=()=>{ $('#photoFull').removeAttribute('src');if(viewerUrl)URL.revokeObjectURL(viewerUrl);viewerUrl=null; };
function setTab(tab,writeHash=true){
  if(!pages.includes(tab))tab='home';
  currentTab=tab;
  for(const p of pages){const el=document.getElementById(p);el.hidden=p!==tab;el.classList.toggle('active',p===tab);}
  for(const b of $$('[data-tab]')){const selected=b.dataset.tab===tab;b.classList.toggle('selected',selected);if(selected)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
  if(writeHash)history.replaceState(null,'',location.pathname+location.search+(tab==='home'?'':'#'+tab));
  document.body.dataset.page=tab;
  window.scrollTo(0,0);
}
function hashTab(){const k=location.hash.slice(1);return ({history:'timeline',stats:'health'})[k] || k || 'home';}
window.addEventListener('hashchange',()=>setTab(hashTab(),false));
function profileAge(birth) {
  if(!birth)return '';
  const born=dayDate(birth), now=dayDate(dateKey(new Date()));
  if(!Number.isFinite(+born)||born>now)return '';
  let months=(now.getFullYear()-born.getFullYear())*12+now.getMonth()-born.getMonth();
  const anniversary=n=>{const base=new Date(born.getFullYear(),born.getMonth()+n,1,12);base.setDate(Math.min(born.getDate(),new Date(base.getFullYear(),base.getMonth()+1,0).getDate()));return base;};
  if(anniversary(months)>now)months--;
  const start=anniversary(months);
  const utcDay=d=>Date.UTC(d.getFullYear(),d.getMonth(),d.getDate());
  const days=(utcDay(now)-utcDay(start))/86400000;
  return months ? months+'个月'+(days?'零'+days+'天':'') : days===0?'出生当天':days+'天';
}
function segment(dayKey) {
  const from=new Date(dayKey+'T00:00:00'),to=new Date(from);to.setDate(to.getDate()+1);
  return [from.getTime(),to.getTime()];
}
function eventInterval(event) {
  const start = event.startedAt ?? eventStamp(event);
  const minutes = Number(event.extra?.duration || 0);
  const end = event.endedAt ?? (active(event) ? Date.now() : start + minutes * 60000);
  return [start,end];
}
function overlapMinutes(type, key) {
  const [from, until] = segment(key);
  const intervals = [];
  for (const event of state.events) {
    if (event.type !== type || (type === 'feed' && event.extra?.method === '奶粉')) continue;
    const [start,end] = eventInterval(event);
    const left = Math.max(start,from), right = Math.min(end,until);
    if (right > left) intervals.push([left,right]);
  }
  intervals.sort((a,b) => a[0]-b[0]);
  let total = 0, previousEnd = from;
  for (const [start,end] of intervals) {
    total += Math.max(0,end-Math.max(previousEnd,start));
    previousEnd = Math.max(previousEnd,end);
  }
  return Math.floor(total/60000);
}
function continuesOn(event,key) {
  if (event.date >= key || !['sleep','feed'].includes(event.type)) return false;
  const [start,end] = eventInterval(event), [from] = segment(key);
  return start < from && end > from;
}
async function refresh(broadcast=false) {
  const generation=++loadGeneration;
  const data=await journal.load();
  if(generation===loadGeneration){
    state=data;
    actor=data.preferences?.parent==='妈妈'?'妈妈':'爸爸';
    render();
  }
  if(broadcast)channel?.postMessage('refresh');
}
async function save(event,template) {
  const saved=await journal.saveEvent(event,template);
  await refresh(true);
  if(!event.id){
    notify('已记录'+names[saved.type],async()=>{
      await journal.removeEvent(saved.id,saved.revision,saved._scope);await refresh(true);notify('已撤销这条记录');
    });
  }else notify('记录已更新');
  return saved;
}
async function endTimer(e) {
  const end=Date.now(),mins=Math.max(0,Math.floor((end-e.startedAt)/60000));
  const detail=e.type==='sleep'?'睡了 '+duration(mins):[e.extra?.method||'母乳',e.extra?.side||'双侧',duration(mins)].join(' · ');
  await save({...e,endedAt:end,endTime:timeKey(new Date(end)),extra:{...finishNursing(e.extra,end),duration:mins},detail});
}
async function quick(type, form=false) {
  if(!journal){notify('日记仍在载入');return;}
  if(quickBusy)return;
  const date=currentTab==='timeline'?day:dateKey(new Date());
  if(form || currentTab!=='home' || date!==dateKey(new Date()) || !['feed','sleep','pee','poop'].includes(type)){
    entry.open(type,{date});return;
  }
  quickBusy=true;
  try{
    const live=state.events.find(e=>e.type===type&&active(e));
    if(live){await endTimer(live);return;}
    const now=new Date(),e={type,date:dateKey(now),time:timeKey(now),actor,_scope:state.scope,extra:{}};
    if(type==='feed'){e.startedAt=+now;e.extra={method:'母乳',side:'双侧'};e.detail='母乳 · 双侧';}
    if(type==='sleep'){e.startedAt=+now;e.detail='睡眠中';}
    if(type==='pee'){e.detail='已记录一次';}
    if(type==='poop'){
      e.detail='已记录一次';
    }
    const saved=await save(e);
    if(type==='poop'){
      clearTimeout(toastTimer);
      const t=$('#toast');
      const add=action('添加照片','undo',()=>{t.classList.remove('show');entry.open('poop',{record:saved,date:saved.date});});
      t.insertBefore(add,t.querySelector('button'));
      toastTimer=setTimeout(()=>t.classList.remove('show'),9000);
    }
  }catch(error){await refresh();notify(error.message);}finally{quickBusy=false;}
}
function displayTitle(e){
  if(active(e))return e.type==='feed'?'喂奶中':'睡眠中';
  if(e.type==='feed')return {'奶粉':'奶粉喂养','母乳':'母乳亲喂','混合喂养':'混合喂养'}[e.extra?.method]||'喂奶';
  if(e.type==='med'||e.type==='supplement')return e.extra?.item || names[e.type];
  return names[e.type] || '记录';
}
function displayDetail(e){
  const x=e.extra||{};
  if(e.type==='feed')return [x.method!=='奶粉'&&x.side,x.volume && x.volume+' ml',active(e)?'已喂 '+duration(elapsed(e)):x.duration!==''&&x.duration!=null?duration(Number(x.duration)):''].filter(Boolean).join(' · ') || e.detail;
  if(e.type==='sleep'&&Number.isFinite(e.startedAt))return (active(e)?'已睡 ':'共 ')+duration(elapsed(e));
  if(['med','supplement'].includes(e.type))return [names[e.type], [x.dose,x.unit].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  return e.detail;
}
async function switchSide(event, side) {
  if (quickBusy) return;
  quickBusy=true;
  try {
    await journal.saveEvent(switchNursingSide(event,side,Date.now()));
    await refresh(true);
  } catch(error) {
    await refresh();
    notify(error.message);
  } finally { quickBusy=false; }
}
function setupRecordActions() {
  const actions=$('#recordActions'), confirmation=$('#deleteDialog');
  let selected;
  $('#actionsClose').onclick=()=>{selected=null;actions.close();};
  $('#actionEdit').onclick=()=>{
    actions.close();
    entry.open(selected.type,{record:selected,date:selected.date});
  };
  $('#actionDelete').onclick=()=>{
    actions.close();
    const photo=selected.extra?.photo instanceof Blob?'及所附照片':'';
    $('#deleteDetail').textContent=selected.date+' '+selected.time+' 的「'+displayTitle(selected)+'」'+photo+'将从日记中移除。';
    confirmation.showModal();
  };
  $('#cancelDelete').onclick=()=>{selected=null;confirmation.close();};
  $('#confirmDelete').onclick=async()=>{
    const button=$('#confirmDelete');
    button.disabled=true;
    const event=selected;
    try {
      const removed=await journal.removeEvent(event.id,event.revision,event._scope);
      selected=null;
      confirmation.close();
      await refresh(true);
      if (!removed) { notify('该记录已删除'); return; }
      notify('已删除'+names[event.type],async()=>{
        await journal.restoreEvent(removed);
        await refresh(true);
        notify('已恢复这条记录');
      });
    } catch(error) {
      confirmation.close();
      await refresh();
      notify(error.message);
    } finally { button.disabled=false; }
  };
  return e=>{
    selected=e;
    $('#actionSubject').textContent=[e.date,e.time,displayTitle(e),e.actor].filter(Boolean).join(' · ');
    actions.showModal();
  };
}
const showRecordActions=setupRecordActions();
function renderRows(id, rows, emptyText, showDate=false) {
  const target=document.getElementById(id);target.replaceChildren();
  if(!rows.length){target.append(elem('p','empty-state',emptyText));return;}
  const fragment=document.createDocumentFragment();
  for(const e of rows){
    const row=elem('article','entry-row'+(active(e)?' is-live':''));
    const time=elem('time','entry-time',e.time);time.dateTime=e.date+'T'+e.time;
    if(showDate || (id==='timelineList' && e.date!==day) || (id==='homeTimeline' && e.date!==todayKey))time.append(elem('small','entry-date',e.date.slice(5).replace('-','/')));
    const mark=elem('span','entry-mark');mark.dataset.kind=e.type;mark.append(glyph(e.type));
    const body=elem('div','entry-body'),heading=elem('div','entry-heading');
    const edit=action(displayTitle(e),'entry-title',()=>entry.open(e.type,{record:e,date:e.date}));
    edit.setAttribute('aria-label','修改'+displayTitle(e)+'，'+e.time);
    const menu=action('···','entry-menu',()=>showRecordActions(e));
    menu.setAttribute('aria-label',displayTitle(e)+' '+e.time+' 的更多操作');
    menu.setAttribute('aria-haspopup','dialog');
    edit.title='修改这条记录';heading.append(edit,elem('span','entry-author',e.actor||''),menu);
    body.append(heading,elem('p','entry-detail',displayDetail(e)));
    if(e.type==='feed' && e.extra?.side !== '左侧' && e.extra?.side !== '右侧'){
      const x=e.extra||{}, live=active(e) && x.sideTimer;
      const sides=live?sideTimes(x.sideTimer,Date.now()):null;
      const left=sides?Math.floor(sides.leftMs/60000):x.leftMinutes, right=sides?Math.floor(sides.rightMs/60000):x.rightMinutes;
      const split=[left!=null?'左侧 '+left+' 分钟':'',right!=null?'右侧 '+right+' 分钟':'',live?x.sideTimer.active+'计时中':''].filter(Boolean);
      if(split.length)body.append(elem('p','entry-detail',split.join(' · ')));
    }
    if(e.extra?.note && !String(e.detail||'').includes(e.extra.note))body.append(elem('p','entry-note',e.extra.note));
    const actions=elem('div','entry-actions');
    if(active(e))actions.append(action(e.type==='sleep'?'宝宝醒了':'结束喂奶','entry-finish',()=>quickFinish(e)));
    if(active(e) && e.type==='feed' && e.extra?.side==='双侧'){
      const current=e.extra.sideTimer?.active;
      for(const side of ['左侧','右侧']){
        if(side!==current) actions.append(action((current?'换到':'计时')+side,'side-switch',()=>switchSide(e,side)));
      }
    }
    if(e.extra?.photo instanceof Blob){
      const photo=action('查看照片','entry-photo',()=>viewPhoto(e.extra.photo));photo.prepend(glyph('photo'));actions.append(photo);
    }
    if(actions.childNodes.length)body.append(actions);
    // The visible menu remains available to keyboard and switch-control users.
    // Horizontal swipes open the same menu. They never perform deletion.
    let touch;
    row.addEventListener('touchstart',event=>{
      touch=event.touches.length===1?{x:event.touches[0].clientX,y:event.touches[0].clientY}:null;
    },{passive:true});
    row.addEventListener('touchend',event=>{
      const end=event.changedTouches[0];
      if(touch && end){
        const dx=touch.x-end.clientX,dy=Math.abs(touch.y-end.clientY);
        if(dx>64 && dx>dy*2)showRecordActions(e);
      }
      touch=null;
    },{passive:true});
    row.addEventListener('touchcancel',()=>{touch=null;},{passive:true});
    row.append(time,mark,body);fragment.append(row);
  }
  target.append(fragment);
}
async function quickFinish(e){
  if(quickBusy)return;
  quickBusy=true;
  try{await endTimer(e);}catch(error){await refresh();notify(error.message);}finally{quickBusy=false;}
}
function renderWeek(){
  const week=$('#weekStrip');week.replaceChildren();
  const date=dayDate(day),monday=new Date(date);
  monday.setDate(monday.getDate()-(monday.getDay()+6)%7);
  for(let i=0;i<7;i++){
    const d=new Date(monday);d.setDate(d.getDate()+i);const k=dateKey(d);
    const button=action('','week-day',()=>selectDay(k));
    button.setAttribute('aria-label',dayFormat(d,{year:'numeric',month:'long',day:'numeric',weekday:'long'}));
    button.setAttribute('aria-pressed',String(k===day));button.classList.toggle('selected',k===day);
    button.append(elem('small','',k===todayKey?'今天':'周'+'日一二三四五六'[d.getDay()]),elem('strong','',d.getDate()));
    week.append(button);
  }
  $('#dateFilter').value=day;
  $('#backToday').hidden=day===todayKey;
}
function selectDay(key){if(!/^\d{4}-\d{2}-\d{2}$/.test(key)||!Number.isFinite(+dayDate(key)))return;day=key;render();}
function statsText(rows){return ['feed','sleep','pee','poop','med','supplement'].map(t=>{const n=rows.filter(e=>e.type===t).length;return n?names[t]+' '+n+' 次':'';}).filter(Boolean).join(' · ');}
function render(){
  const now=new Date(),newToday=dateKey(now);
  if(newToday!==todayKey){if(day===todayKey)day=newToday;todayKey=newToday;}
  const rows=sorted(state.events),todays=rows.filter(e=>e.date===todayKey), chosen=rows.filter(e=>e.date===day);
  const feeds=todays.filter(e=>e.type==='feed'),running=rows.filter(active);
  const age=profileAge(state.profile.birthDate),nickname=state.profile.babyName || '小茉莉';
  putText('today', dayFormat(now,{month:'long',day:'numeric',weekday:'long'}));
  putText('age',age);putText('heroTitle', running.find(e=>e.type==='sleep')?'小睡进行中':nickname+'的一天');
  const lastFeed=rows.find(e=>e.type==='feed');
  const heroText=running.length?running.map(e=>(e.type==='sleep'?'已睡 ':'已喂 ')+duration(elapsed(e))).join(' · '):lastFeed?'上次喂奶 '+(lastFeed.date===todayKey?'':lastFeed.date.slice(5)+' ')+lastFeed.time:'还没有喂奶记录';
  putText('heroDetail',heroText);putText('eventCount',todays.length+' 条记录');putText('lastEvent',todays.length?'最近 '+todays[0].time:'');
  putText('feedCount',feeds.length+' 次');
  const volume=feeds.reduce((n,e)=>n+Number(e.extra?.volume||0),0);
  const nursing=overlapMinutes('feed',todayKey);
  putText('feedVolume',[volume?'瓶喂 '+volume+' ml':'',nursing?'亲喂 '+nursing+' 分钟':''].filter(Boolean).join(' · '));
  putText('sleepTotal',duration(overlapMinutes('sleep',todayKey)));putText('peeCount',todays.filter(e=>e.type==='pee').length+' 次');putText('poopCount',todays.filter(e=>e.type==='poop').length+' 次');
  for(const b of $$('#home [data-action]')){
    const type=b.dataset.action, live=running.find(e=>e.type===type);
    const title=b.querySelector('.action-label');
    if(title){title.textContent=live?(type==='sleep'?'宝宝醒了':'结束喂奶'):names[type];b.setAttribute('aria-label',title.textContent);}
    b.classList.toggle('running',!!live);
  }
  renderRows('homeTimeline',rows.filter(e=>e.date===todayKey || (active(e) && continuesOn(e,todayKey))).slice(0,4),'今天的第一条记录会出现在这里。');
  renderWeek();putText('timelineHeading',dayFormat(dayDate(day),{month:'long',day:'numeric'}));
  const continued = rows.filter(event => continuesOn(event,day));
  const minutesAsleep = overlapMinutes('sleep',day);
  const minutesFeeding = overlapMinutes('feed',day);
  const summary = [chosen.length+' 条新记录',statsText(chosen)];
  if (continued.length) summary.push(continued.length+' 条跨日延续');
  if (minutesAsleep) summary.push('当日睡眠 '+duration(minutesAsleep));
  if (minutesFeeding) summary.push('当日亲喂 '+duration(minutesFeeding));
  putText('timelineSummary',summary.filter(Boolean).join(' · '));
  renderRows('timelineList',[...chosen,...continued],'这一天还没有记录。');
  renderRows('healthList',rows.filter(e=>healthTypes.has(e.type)).slice(0,16),'还没有健康或成长记录。',true);
  const cat=$('#catalog');cat.replaceChildren();
  if(!state.catalog.length)cat.append(elem('p','empty-state','记录用药或营养品时，勾选「保存为常用」即可在这里快速选择。'));
  for(const t of state.catalog){const b=action(t.item,'template-button',()=>entry.open(t.type,{date:todayKey,template:t}));b.prepend(glyph(t.type));cat.append(b);}
  putText('profileTitle',nickname);putText('profileSummary',[age,state.profile.sex && state.profile.sex!=='暂不填写'?state.profile.sex:''].filter(Boolean).join(' · ')||'填写出生日期后显示月龄');
  const measures=rows.filter(e=>e.type==='growth');
  const growth=$('#recentGrowth');growth.replaceChildren();
  for(const [key,label,unit] of [['weight','体重','g'],['length','身长','cm'],['head','头围','cm']]){
    const item=measures.find(e=>e.extra?.[key]!=='' && e.extra?.[key]!=null);
    const birthField={weight:'birthWeight',length:'birthLength',head:'birthHead'}[key];
    const value=item?.extra[key] || state.profile[birthField];
    const box=elem('div','growth-metric'); box.append(elem('small','',label),elem('strong','',value?value+' '+unit:'—'),elem('small','',item?item.date:value?'出生时':'待测量'));growth.append(box);
  }
  for(const button of $$('[data-parent]'))button.setAttribute('aria-pressed', String(button.dataset.parent===actor));
  putText('actorName',actor+'记录');$('#profileShortcut').setAttribute('aria-label','打开宝宝档案，当前记录人'+actor);putText('dateLabel',day.slice(0,7).replace('-','.'));
}

function setupProfileForm(){
  const form=$('#profileForm'),edit=$('#profileEdit');
  let editingProfile;
  $('#birthDate').max=dateKey(new Date());
  edit.onclick=()=>{
    form.hidden=!form.hidden;
    edit.setAttribute('aria-expanded',String(!form.hidden));
    if(!form.hidden){
      editingProfile={...state.profile,_scope:state.scope,revision:state.profile.revision??0};
      for(const key of profileFields)document.getElementById(key).value=editingProfile[key]??'';
    }
  };
  form.onsubmit=async ev=>{
    ev.preventDefault();if(!form.reportValidity()||!journal)return;
    const values=Object.fromEntries(profileFields.map(key=>[key,document.getElementById(key).value.trim()]));
    $('#saveProfile').disabled=true;
    try{
      await journal.saveProfile({...editingProfile,...values});form.hidden=true;edit.setAttribute('aria-expanded','false');await refresh(true);notify('宝宝档案已保存');
    }catch(error){notify(error.message);}finally{$('#saveProfile').disabled=false;}
  };
}
// A gesture that begins inside a sheet (including a scroll or photo drag) never dismisses it.
function enableBackdropDismissal() {
  let pressed;
  function outside(dialog, event) {
    if (!(dialog instanceof HTMLDialogElement) || !dialog.open) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom;
  }
  document.addEventListener('pointerdown', event => {
    pressed = outside(event.target,event) ? event.target : null;
  });
  document.addEventListener('pointercancel', () => { pressed=null; });
  document.addEventListener('click', event => {
    const dialog = pressed;
    pressed=null;
    if (dialog !== event.target || !outside(dialog,event)) return;
    if (dialog.querySelector('button[type="submit"]:disabled, #confirmRestore:disabled, #confirmDelete:disabled')) return;
    if (dialog.dispatchEvent(new Event('cancel',{cancelable:true}))) dialog.close();
  });
}
function setupUI(){
  enableBackdropDismissal();
  const compose=$('#composeDialog');
  $$('[data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
  $$('[data-goto]').forEach(b=>b.onclick=()=>{day=todayKey;render();setTab(b.dataset.goto);});
  $('#profileShortcut').onclick=()=>setTab('profile');
  $$('[data-action]').forEach(b=>b.onclick=()=>quick(b.dataset.action));
  $('#dateFilter').onchange=e=>selectDay(e.target.value);
  $('#backToday').onclick=()=>selectDay(dateKey(new Date()));
  for(const [selector,delta] of [['#prevWeek',-7],['#nextWeek',7]]) $(selector).onclick=()=>{
    const d=dayDate(day);d.setDate(d.getDate()+delta);selectDay(dateKey(d));
  };
  const list=$('#composeList');
  for(const t of Object.keys(names)){
    const b=action(names[t],'compose-type',()=>{compose.close();if(entry)entry.open(t,{date:currentTab==='timeline'?day:todayKey,mode:'complete'});});
    b.prepend(glyph(t));list.append(b);
  }
  $$('[data-compose]').forEach(b=>b.onclick=()=>{if(!entry){notify('日记仍在载入');return;}compose.showModal();});
  $('#composeClose').onclick=()=>compose.close();
  const parents = $$('[data-parent]');
  for(const button of parents)button.onclick=async()=>{
    if (!journal) return;
    parents.forEach(b=>{b.disabled=true;});
    try {
      await journal.savePreferences({parent:button.dataset.parent});
      await refresh(true);
    } catch(error){notify(error.message);}
    finally{parents.forEach(b=>{b.disabled=false;});}
  };
  setupProfileForm();
}
hydrateIcons();
setupUI();setTab(hashTab(),false);
try{
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
  journal=await openJournal(storeName);
  try {
    const imported=await migrateLegacyBrowser(journal);
    if(imported?.added) $('#backupStatus').textContent='已从旧版本机日记迁入 '+imported.added+' 项。';
  } catch(error) {
    $('#backupStatus').textContent='旧版数据仍在原处。刷新可重新迁入。'+error.message;
    notify('旧版日记迁入未完成，请查看宝宝档案。');
  }
  entry=createEntryController({getEvents:()=>state.events,getCatalog:()=>state.catalog,getParent:()=>actor,getScope:()=>state.scope,save,notify,viewPhoto});
  await refresh();
  setupBackup({journal,refresh:()=>refresh(true),notify});
  document.body.dataset.locked="false";
  void setupGitFamily({journal,refresh,notify}).catch(e=>notify(e.message));
  $('#openStatus').hidden=true;
  if(channel)channel.onmessage=()=>refresh().catch(e=>notify(e.message));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh().catch(e=>notify(e.message));});
  setInterval(()=>{if(!document.hidden && (state.events.some(active) || todayKey!==dateKey(new Date())))render();},30000);
}catch(error){
  document.body.dataset.locked='true';
  $('#openMessage').textContent='本机日记未能打开。'+error.message;
  $('#retryOpen').hidden=false;
  $('#retryOpen').onclick=()=>location.reload();
}
