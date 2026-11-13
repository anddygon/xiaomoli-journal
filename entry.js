import { compressPhoto } from './photo-compress.js';

const titles = {
  feed: '喂奶', sleep: '睡眠', pee: '尿尿', poop: '便便', med: '用药',
  supplement: '营养品', temperature: '体温', vaccine: '疫苗', growth: '成长测量'
};
const pad = number => String(number).padStart(2, '0');
const dayKey = date => [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
const clock = date => pad(date.getHours()) + ':' + pad(date.getMinutes());
const FULL = '补记一次', TIMER = '开始计时';
const join = (...values) => values.filter(Boolean).join(' · ');

// Side tracking starts when a parent chooses a side. Time before that choice
// stays in the session total without being assigned to either side.
export function sideTimes(timer, end) {
  let leftMs = Number(timer?.leftMs) || 0;
  let rightMs = Number(timer?.rightMs) || 0;
  const delta = timer ? Math.max(0,end - timer.since) : 0;
  if (timer?.active === '左侧') leftMs += delta;
  if (timer?.active === '右侧') rightMs += delta;
  return {leftMs,rightMs};
}

export function switchNursingSide(record, nextSide, now) {
  const totals = sideTimes(record.extra?.sideTimer,now);
  return {...record,extra:{...record.extra,side:'双侧',sideTimer:{...totals,active:nextSide,since:now}}};
}

export function finishNursing(extra, end) {
  if (!extra?.sideTimer) return {...extra};
  const {leftMs,rightMs} = sideTimes(extra.sideTimer,end);
  const result = {...extra,leftMinutes:Math.floor(leftMs/60000),rightMinutes:Math.floor(rightMs/60000)};
  delete result.sideTimer;
  return result;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function inputRow(parent, label, name, value, options = {}) {
  const wrap = el('label', 'entry-field');
  wrap.append(el('span', 'entry-label', label));
  const input = el('input', 'entry-input');
  input.name = name;
  Object.assign(input, options);
  input.value = value ?? '';
  wrap.append(input);
  parent.append(wrap);
  return input;
}

function choice(parent, label, name, values, selected) {
  const fieldset = el('fieldset', 'entry-group');
  fieldset.append(el('legend', 'entry-label', label));
  const choices = el('div', 'entry-options');
  for (const value of values) {
    const option = el('label', 'entry-option');
    const input = el('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = value === selected;
    option.append(input, el('span', '', value));
    choices.append(option);
  }
  fieldset.append(choices);
  parent.append(fieldset);
  return fieldset;
}

function group(parent, className = '') {
  const node = el('div', className);
  parent.append(node);
  return node;
}

function toggleSection(node, visible) {
  node.hidden = !visible;
  node.querySelectorAll('input,select,textarea').forEach(input => input.disabled = !visible);
}

function photoPicker(parent, initialPhoto, onBusy, viewPhoto) {
  parent.append(el('span','entry-label','照片（选填）'));
  const actions = group(parent,'entry-photo-actions');
  const preview = group(parent,'entry-photo-preview');
  const view = el('button','entry-photo-view');
  view.type = 'button';
  view.setAttribute('aria-label','放大查看照片');
  const thumbnail = el('img');
  thumbnail.alt = '便便照片缩略图';
  view.append(thumbnail);
  const info = el('span','entry-photo-size');
  const remove = el('button','entry-photo-remove','移除');
  remove.type = 'button';
  preview.append(view,info,remove);
  const message = el('p','entry-status');
  message.setAttribute('role','status');
  parent.append(message);
  let photo = initialPhoto instanceof Blob ? initialPhoto : null;
  let url, revision = 0;
  function showPhoto() {
    if (url) URL.revokeObjectURL(url);
    url = null;
    thumbnail.removeAttribute('src');
    preview.hidden = !photo;
    if (!photo) return;
    url = URL.createObjectURL(photo);
    thumbnail.src = url;
    info.textContent = Math.ceil(photo.size / 1024) + ' KB';
  }
  const clear = () => {
    ++revision;
    photo = null;
    showPhoto();
    message.textContent = '';
    onBusy(false);
  };
  for (const [caption, capture] of [['拍照', true], ['从相册选', false]]) {
    const button = el('button','entry-photo-action',caption);
    button.type = 'button';
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (capture) input.setAttribute('capture','environment');
    input.hidden = true;
    button.onclick = () => input.click();
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      input.value = '';
      const selection = ++revision;
      message.textContent = '正在压缩照片…';
      onBusy(true);
      try {
        const result = await compressPhoto(file);
        if (selection !== revision) return;
        photo = result.blob;
        showPhoto();
        message.textContent = '';
      } catch {
        if (selection === revision) message.textContent = (photo ? '换图失败，已保留原来的照片。' : '这张照片未能读取。') + '可重拍、选 JPG，或仅保存文字。';
      } finally {
        if (selection === revision) onBusy(false);
      }
    };
    actions.append(button,input);
  }
  view.onclick = () => { if (photo) viewPhoto?.(photo); };
  remove.onclick = clear;
  showPhoto();
  return { get: () => photo, dispose: clear };
}

export function createEntryController({getEvents, getCatalog, getParent, getScope, save, notify, viewPhoto}) {
  const dialog = document.getElementById('entryDialog');
  const form = document.getElementById('entryForm');
  const fields = document.getElementById('formFields');
  const submit = document.getElementById('submitEntry');
  const cancel = document.getElementById('cancelEntry');
  const title = document.getElementById('dialogTitle');
  let type, original, openedScope, photo, saving = false, processing = false;
  let date, time, status, recalc;
  const viewport = window.visualViewport;
  function fitViewport() {
    if (!viewport) return;
    dialog.style.setProperty('--entry-visible-bottom',(viewport.offsetTop + viewport.height)+'px');
    dialog.style.setProperty('--entry-visible-height',Math.floor(viewport.height * .94)+'px');
  }
  viewport?.addEventListener('resize',fitViewport);
  viewport?.addEventListener('scroll',fitViewport);
  const setBusy = () => { submit.disabled = saving || processing; cancel.disabled = saving; };
  const tell = (text) => { status.textContent = text; if (text) status.scrollIntoView({block:'nearest'}); };
  const get = name => {
    const field = form.elements.namedItem(name);
    return field && !field.disabled ? String(field.value).trim() : '';
  };

  function setupTime(parent, dateValue, timeValue) {
    const row = group(parent, 'entry-datetime');
    date = inputRow(row, '日期', 'date', dateValue, {type:'date', required:true, max:dayKey(new Date())});
    const label = type === 'sleep' ? '入睡时间' : type === 'feed' ? '喂奶时间' : '发生时间';
    time = inputRow(row, label, 'time', timeValue, {type:'time', required:true});
  }

  function setupFeedOrSleep(existing, editingDay, mode) {
    const feed = type === 'feed';
    const current = new Date();
    const originalDate = original?.date ?? editingDay;
    const isTimed = original?.startedAt != null && original?.endedAt == null;
    const canStart = dayKey(current) === originalDate && !original;
    const selectedMode = isTimed || (canStart && mode !== 'complete') ? TIMER : FULL;
    if (feed) {
      choice(fields, '喂养方式','method',['母乳','奶粉','混合喂养'],existing.method || '母乳');
    }
    const modeBox = group(fields);
    choice(modeBox, feed ? '记录方式' : '睡眠状态', 'mode',[TIMER,FULL],selectedMode);
    const breast = group(fields);
    if (feed) choice(breast,'母乳侧别','side',['双侧','左侧','右侧'],existing.side || '双侧');
    const bottle = group(fields);
    if (feed) inputRow(bottle,'实际奶量（ml）','volume',existing.volume,{type:'number', min:'1', step:'1', required:true, inputMode:'numeric'});
    const durationBox = group(fields);
    const mins = existing.duration ?? (original?.endedAt != null && original?.startedAt != null ? Math.max(0,Math.round((original.endedAt - original.startedAt)/60000)) : '');
    const durationField = inputRow(durationBox,feed ? '时长（分钟，选填）' : '睡了多久（分钟）','duration',mins,{type:'number',min:'0',step:'1',required:!feed,inputMode:'numeric',placeholder:feed?'可留空':'例如 45'});
    let sidesBox, left, right;
    if (feed) {
      sidesBox = el('details','entry-side-detail');
      const toggle = el('summary','','分别填写左右时长');
      sidesBox.append(toggle);
      const pair = group(sidesBox,'entry-doses');
      const split = original?.extra?.sideTimer ? finishNursing(existing,Date.now()) : existing;
      const opts = {type:'number',min:'0',step:'1',inputMode:'numeric',placeholder:'选填'};
      left = inputRow(pair,'左侧时长（分钟）','leftMinutes',split.leftMinutes,opts);
      right = inputRow(pair,'右侧时长（分钟）','rightMinutes',split.rightMinutes,opts);
      sidesBox.open = split.leftMinutes != null || split.rightMinutes != null;
      fields.append(sidesBox);
    }
    return () => {
      const hasBreast = !feed || get('method') !== '奶粉';
      const canTime = (!feed || get('method') === '母乳') && (!original || isTimed);
      toggleSection(modeBox,canTime);
      const mode = form.elements.namedItem('mode');
      if (mode) {
        const timer = Array.from(mode).find(input => input.value === TIMER);
        if (timer) {
          timer.disabled = !canTime || (date.value !== dayKey(new Date()) && !isTimed);
          if (timer.checked && timer.disabled) mode.value = FULL;
        }
      }
      const timed = canTime && get('mode') === TIMER;
      toggleSection(breast, feed && hasBreast);
      toggleSection(bottle, feed && get('method') !== '母乳');
      toggleSection(durationBox,!timed && hasBreast);
      if (sidesBox) {
        const allowSplit = !timed && hasBreast && get('side') === '双侧';
        toggleSection(sidesBox,allowSplit);
        if (allowSplit && (left.value || right.value) && !durationField.value) durationField.placeholder = '按左右时长合计';
      }
      if (!timed && !feed) durationField.required = true;
      submit.textContent = original ? '保存修改' : timed ? (feed ? '开始喂奶' : '开始睡眠') : '保存记录';
    };
  }

  function setupMedication(existing, template) {
    const templates = (getCatalog?.() || []).filter(item => item.type === type);
    if (templates.length) {
      const row = el('label','entry-field');
      row.append(el('span','entry-label','常用项目'));
      const select = el('select','entry-input');
      select.append(new Option('选择常用项目',''));
      templates.forEach((item,index) => select.append(new Option(item.item,String(index))));
      select.onchange = () => {
        if (!select.value) return;
        const item = templates[Number(select.value)];
        for (const key of ['item','dose','unit']) form.elements.namedItem(key).value = item[key] || '';
      };
      row.append(select);
      fields.append(row);
    }
    const values = original ? existing : template || {};
    inputRow(fields,type === 'med' ? '药品名称' : '营养品名称','item',values.item,{required:true, maxLength:100, placeholder:type === 'med' ? '填写药品名称' : '例如 益生菌'});
    const doses = group(fields,'entry-doses');
    inputRow(doses,'实际用量','dose',values.dose,{maxLength:50,placeholder:'按本次填写'});
    inputRow(doses,'单位','unit',values.unit,{maxLength:24,placeholder:'例如 滴、袋'});
    const label = el('label','entry-remember');
    const box = el('input');
    box.name = 'remember'; box.type = 'checkbox';
    label.append(box, '保存为常用项目');
    fields.append(label);
  }

  function open(kind, {date: day, record, template, mode} = {}) {
    if (!Object.hasOwn(titles,kind) || saving) return;
    if (dialog.open) dialog.close();
    photo?.dispose(); photo = null;
    type = kind; original = record; openedScope=record?._scope ?? getScope(); processing = false; recalc = null;
    const now = new Date();
    const dateValue = record?.date || day || dayKey(now);
    const existing = record?.extra || {};
    title.textContent = (record ? '修改' : '记录') + titles[type];
    fields.replaceChildren();
    submit.textContent = record ? '保存修改' : '保存记录';
    setBusy();
    switch(type) {
      case 'feed': case 'sleep':
        recalc = setupFeedOrSleep(existing, dateValue, mode);
        break;
      case 'pee':
        choice(fields,'尿量（选填）','amount',['正常','较少','较多'],existing.amount || record?.detail?.match(/较少|较多|正常/)?.[0]);
        break;
      case 'poop': {
        choice(fields,'颜色（选填）','color',['黄色','黄绿色','绿色','棕色','其他'],existing.color);
        choice(fields,'性状（选填）','texture',['糊状','成形','稀便','水样'],existing.texture);
        photo = photoPicker(group(fields,'entry-photo'),existing.photo,value => { processing=value; setBusy(); },viewPhoto);
        break;
      }
      case 'med': case 'supplement':
        setupMedication(existing,template);
        break;
      case 'growth': {
        const measures = [['体重（g）','weight','.1'],['身长（cm）','length','.1'],['头围（cm）','head','.1']];
        for (const [label,name,step] of measures) inputRow(fields,label,name,existing[name],{type:'number',min:'.1',step,inputMode:'decimal',placeholder:'选填'});
        break;
      }
      case 'vaccine':
        inputRow(fields,'疫苗名称','item',existing.item,{required:true,maxLength:100});
        break;
      case 'temperature':
        inputRow(fields,'体温（℃）','value',existing.value,{type:'number',required:true,min:'0.1',step:'.1',inputMode:'decimal'});
        choice(fields,'测量部位','site',['腋下','耳温','额温','其他'],existing.site || record?.detail?.match(/腋下|耳温|额温|其他/)?.[0] || '腋下');
        break;
    }
    setupTime(fields,dateValue,record?.time || clock(now));
    inputRow(fields,type === 'vaccine' ? '剂次或备注（选填）' : '备注（选填）','note',existing.note ?? original?.note,{maxLength:1000});
    status = el('p','entry-status');
    status.setAttribute('role','status');
    fields.append(status);
    recalc?.(); fitViewport(); dialog.showModal(); dialog.scrollTop=0;
  }

  function buildRecord() {
    // Native time controls may serialize zero seconds or fractional seconds. The diary uses minutes.
    const minute = time.value.slice(0,5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(minute)) throw new Error('请选择有效的发生时间。');
    const [year,month,day] = date.value.split('-').map(Number);
    const [hour,minutes] = minute.split(':').map(Number);
    const localDate = new Date(year,month-1,day,hour,minutes);
    const start = localDate.getTime();
    if (dayKey(localDate)!==date.value || clock(localDate)!==minute) throw new Error('请选择有效的本地日期和时间。');
    const now = Date.now();
    if (!Number.isFinite(start) || start > now) throw new Error('请选择已经发生的日期和时间。');
    const extra = {...original?.extra};
    const event = {...original,_scope:openedScope,type,date:date.value,time:minute,extra,actor:original?.actor ?? getParent(),
      createdAt: original?.createdAt ?? new Date().toISOString(),status:'local'};
    extra.time = minute;
    extra.note = get('note');
    if (type === 'feed' || type === 'sleep') {
      const feed = type === 'feed';
      const method = get('method');
      const modeGroup = form.querySelector('[name="mode"]:checked');
      const timed = modeGroup && !modeGroup.disabled && modeGroup.value === TIMER;
      let duration = get('duration');
      if (feed) {
        extra.method = method; extra.side = method === '奶粉' ? '' : get('side');
        extra.volume = method === '母乳' ? '' : get('volume');
        if (timed && extra.sideTimer && (original?.date !== date.value || original?.time !== minute || extra.side !== '双侧')) {
          throw new Error('正在分侧计时。请先结束这次喂奶，再修改开始时间或侧别。');
        }
        if (!timed) {
          delete extra.sideTimer;
          delete extra.leftMinutes;
          delete extra.rightMinutes;
          if (extra.side === '双侧') {
            const left = get('leftMinutes'), right = get('rightMinutes');
            if (left !== '' || right !== '') {
              const sum = Number(left) + Number(right);
              if (duration && sum > Number(duration)) throw new Error('左右时长之和超过总时长，请核对。');
              if (!duration) duration = String(sum);
              if (left !== '') extra.leftMinutes = Number(left);
              if (right !== '') extra.rightMinutes = Number(right);
            }
          }
        }
      }
      delete event.startedAt; delete event.endedAt; delete event.endTime;
      extra.duration = timed || method === '奶粉' ? '' : duration;
      if (timed) {
        const another = (getEvents() || []).some(e => e.id !== original?.id && e.type === type && e.startedAt != null && e.endedAt == null);
        if (another) throw new Error('已有一条'+titles[type]+'正在计时，可在首页结束。');
        const preserveStart = original?.date === date.value && original?.time === minute && original?.startedAt != null;
        event.startedAt = preserveStart ? original.startedAt : start === Math.floor(now/60000)*60000 ? now : start;
      } else if (extra.duration !== '') {
        const oldDuration = original?.extra?.duration ?? (original?.startedAt != null && original?.endedAt != null ? Math.round((original.endedAt-original.startedAt)/60000) : null);
        const preserveInterval = original?.endedAt != null && original?.startedAt != null && date.value === original.date && minute === original.time && Number(oldDuration) === Number(duration);
        event.startedAt = preserveInterval ? original.startedAt : start;
        event.endedAt = preserveInterval ? original.endedAt : start + Number(duration)*60000;
        if (event.endedAt > now) throw new Error('按这个时长计算，结束时间晚于现在。');
      } else if (feed) {
        // A completed feed with unspecified duration has no timer interval.
        event.endedAt = start;
      }
      event.detail = feed ? join(method, extra.side, extra.volume && extra.volume+' ml', extra.duration && extra.duration+' 分钟') : timed ? '睡眠中' : '睡了 '+duration+' 分钟';
    } else if (type === 'pee') {
      extra.amount = get('amount'); event.detail=extra.amount?'尿量'+extra.amount:'已记录一次';
    } else if (type === 'poop') {
      extra.color = get('color'); extra.texture = get('texture');
      if (photo?.get()) extra.photo=photo.get(); else delete extra.photo;
      event.detail=join(extra.color,extra.texture) || '已记录一次';
    } else if (type === 'med' || type === 'supplement') {
      extra.item=get('item'); extra.dose=get('dose'); extra.unit=get('unit');
      if (!extra.item) throw new Error('请填写名称。');
      if (extra.unit && !extra.dose) throw new Error('已填写单位，请补上实际用量或清空单位。');
      event.detail=join(extra.item, extra.dose+extra.unit);
    } else if (type === 'growth') {
      extra.weight=get('weight'); extra.length=get('length'); extra.head=get('head');
      if (!extra.weight && !extra.length && !extra.head) throw new Error('请至少填写一项测量值。');
      event.detail=join(extra.weight && '体重 '+extra.weight+' g',extra.length && '身长 '+extra.length+' cm',extra.head && '头围 '+extra.head+' cm');
    } else if (type === 'temperature') {
      extra.value=get('value'); extra.site=get('site'); event.detail=join(extra.value+' ℃',extra.site);
    } else if (type === 'vaccine') {
      extra.item=get('item'); if (!extra.item) throw new Error('请填写疫苗名称。');
      event.detail=extra.item;
    }
    return event;
  }
  form.addEventListener('change', () => {if (!dialog.open) return; recalc?.(); tell('');});
  async function submitRecord() {
    if (saving || processing || !form.reportValidity()) return;
    saving = true; setBusy();
    try {
      const record = buildRecord();
      const template = form.elements.namedItem('remember')?.checked
        ? {type,item:record.extra.item,dose:record.extra.dose,unit:record.extra.unit} : undefined;
      await save(record,template);
      dialog.close();
    } catch (error) {
      tell(error instanceof Error && error.message ? error.message : '暂时无法保存，请重试。');
    } finally {
      saving = false; setBusy();
    }
  }
  // The primary action uses one explicit save path. Native dialog-form submission
  // may dismiss or suppress validation before an asynchronous IndexedDB write.
  submit.addEventListener('click',event=>{event.preventDefault();void submitRecord();});
  form.addEventListener('submit',event=>{event.preventDefault();void submitRecord();});
  cancel.type = 'button';
  cancel.onclick = () => {if (!saving) dialog.close();};
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    photo?.dispose();
    photo = null;
  });
  return {open,close() { if (!saving && dialog.open) dialog.close(); }};
}
