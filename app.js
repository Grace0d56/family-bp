(function () {
  'use strict';
  const {DemoBackend,SupabaseBackend,validateConfig,RequestError,uid,today}=window.BPBackend;
  const ROOT=document.getElementById('app');
  const CLOUD_SETTINGS_KEY='family-bp-project-config-v1';
  const FONT_KEY='family-bp-large-font-v1';
  const FILTERS_KEY='family-bp-chart-filters-v1';
  const MED_LABELS={
    no:'平时不服用降压药',before:'今天服药前测量',after:'今天服药后测量',
    missed:'本应服药，但忘了服用',unknown:'不确定 / 未记录'
  };
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const parseStored=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
  const saveStored=(key,value)=>localStorage.setItem(key,JSON.stringify(value));
  const nowTime=()=>{const d=new Date();return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
  const freshDraft=()=>({measured_on:today(),measured_time:nowTime(),systolic:'',diastolic:'',pulse:'',medication_status:'unknown',note:''});
  const labelTime=r=>`${String(r.measured_on).replaceAll('-','/')} ${String(r.measured_time).slice(0,5)}`;
  const sortRecords=arr=>arr.sort((a,b)=>`${b.measured_on}T${b.measured_time}${b.created_at||''}`.localeCompare(`${a.measured_on}T${a.measured_time}${a.created_at||''}`));
  const isNetworkError=e=>e?.kind==='network';
  const isLikelySchemaError=e=>/PGRST205|PGRST116|42P01|does not exist|schema cache|Could not find the table/i.test(e?.message||'');
  const friendlyError=e=>isLikelySchemaError(e)?'数据库表尚未建立。请先在 Supabase SQL Editor 运行 database.sql。':(e?.message||'操作失败，请再试一次');
  const sizeLabel=on=>on?'特大字':'大字';
  const getConfig=()=>{
    const override=parseStored(CLOUD_SETTINGS_KEY,null);
    const file=window.BP_CONFIG||{};
    // A deployment-wide config.js takes precedence over temporary per-device setup.
    const c=(file.supabaseUrl&&file.supabasePublishableKey)?file:(override||file);
    return {url:(c.supabaseUrl||c.url||'').trim(),key:(c.supabasePublishableKey||c.key||'').trim()};
  };
  let conf=getConfig();
  const cloudMode=!!(conf.url&&conf.key);
  const backend=cloudMode?new SupabaseBackend(conf.url,conf.key):new DemoBackend();
  const identity=backend.user?.id||'visitor';
  const scope=()=>`family-bp-${backend.mode}-${backend.user?.id||'visitor'}`;
  const draftKey=(memberId)=>`${scope()}:draft:${memberId}`;
  const pendingKey=()=>`${scope()}:pending`;
  const cacheKey=(part)=>`${scope()}:cache:${part}`;
  const state={
    backend, cloudMode, page:'record', members:[],activeId:localStorage.getItem(`${scope()}:default-member`)||null,
    readings:[], loadedFor:null, pending:parseStored(pendingKey(),[]), offline:false,
    notice:'',noticeType:'success', loading:false,busy:false, editingId:null,editingPending:false,
    draft:freshDraft(), newName:'',newMeds:false,memberEditorId:null,editName:'',editMeds:false,
    addingMember:false,delId:null,saveUnusual:false,selectedPoint:null,
    filters:parseStored(FILTERS_KEY,{range:'30',part:'all'}),fontXL:parseStored(FONT_KEY,false),
    signup:false,authEmail:'',authPassword:'',testCode:localStorage.getItem(`${scope()}:test-code`)||'',
    lastRemoteTest:null,connectingUrl:conf.url,connectingKey:conf.key
  };

  const member=()=>state.members.find(x=>x.id===state.activeId)||null;
  const say=(message,type='success')=>{state.notice=message;state.noticeType=type;render();};
  const clearNotice=()=>{state.notice='';state.noticeType='success';};
  const keepDraft=()=>{if(state.activeId)saveStored(draftKey(state.activeId),state.draft);};
  const changeDraftTo=(id)=>{state.draft=parseStored(draftKey(id),freshDraft());state.editingId=null;state.editingPending=false;};
  const keepPending=()=>saveStored(pendingKey(),state.pending);
  const visibleRecords=()=>{
    const ids=new Set(state.readings.map(x=>x.id));
    return sortRecords([...state.readings,...state.pending.filter(x=>x.member_id===state.activeId&&!ids.has(x.id)).map(x=>({...x,_pending:true}))]);
  };
  const refreshStatus=()=>{
    if(!state.cloudMode)return '<span class="status warn"><span class="dot"></span>演示模式</span>';
    if(!backend.user)return '<span class="status warn"><span class="dot"></span>尚未登录</span>';
    if(state.pending.length)return `<span class="status warn"><span class="dot"></span>${state.pending.length} 条未同步</span>`;
    if(state.offline)return '<span class="status bad"><span class="dot"></span>连接异常</span>';
    return '<span class="status"><span class="dot"></span>云端已连接</span>';
  };

  async function loadMembers({silent=false}={}) {
    try {
      const rows=await backend.listMembers();state.members=rows;state.offline=false;
      saveStored(cacheKey('members'),rows);
      if(!rows.some(x=>x.id===state.activeId)){
        state.activeId=rows[0]?.id||null;
      }
      if(state.activeId){localStorage.setItem(`${scope()}:default-member`,state.activeId);changeDraftTo(state.activeId);}
      else{state.draft=freshDraft();state.loadedFor=null;state.readings=[];}
      return true;
    } catch(e) {
      state.offline=true;
      const cache=parseStored(cacheKey('members'),[]);
      if(cache.length) {
        state.members=cache;
        if(!cache.some(x=>x.id===state.activeId))state.activeId=cache[0].id;
        changeDraftTo(state.activeId);
        if(!silent){state.notice='网络连接失败，正在显示本机缓存。新增记录将保存在本机等待同步。';state.noticeType='warn';}
        return false;
      }
      if(!silent){state.notice=friendlyError(e);state.noticeType='error';}
      return false;
    }
  }
  async function loadReadings({silent=false}={}) {
    if(!state.activeId){state.readings=[];state.loadedFor=null;return;}
    const id=state.activeId;
    try{
      const rows=await backend.listMeasurements(id);
      if(state.activeId!==id)return;
      state.readings=rows;state.loadedFor=id;state.offline=false;
      saveStored(cacheKey(`records:${id}`),rows);
      // A previous upload can have reached the server even if its reply was lost.
      const remoteIds=new Set(rows.map(r=>r.id));
      const count=state.pending.length;
      state.pending=state.pending.filter(p=>p.member_id!==id||!remoteIds.has(p.id));
      if(state.pending.length!==count)keepPending();
    }catch(e){
      if(state.activeId!==id)return;
      state.offline=true;
      state.readings=parseStored(cacheKey(`records:${id}`),[]);
      state.loadedFor=id;
      if(!silent){state.notice=friendlyError(e);state.noticeType='warn';}
    }
  }
  async function reload({silent=false}={}) {
    if(state.busy||!backend.user)return;
    if(!silent){state.busy=true;render();}
    await loadMembers({silent});await loadReadings({silent});
    if(!silent){state.busy=false;if(!state.offline){state.notice='已读取最新云端记录';state.noticeType='success';}render();}
    else if(!document.activeElement?.matches('input,textarea,select'))render();
  }
  async function switchMember(id) {
    if(!state.members.some(x=>x.id===id))return;
    keepDraft();state.activeId=id;localStorage.setItem(`${scope()}:default-member`,id);
    changeDraftTo(id);state.page='record';clearNotice();state.delId=null;
    state.readings=parseStored(cacheKey(`records:${id}`),[]);render();
    await loadReadings({silent:true});render();
  }

  function noticeHtml(){return state.notice?`<div class="notice ${esc(state.noticeType)}" role="status">${esc(state.notice)}</div>`:'';}
  function topHtml(){
    return `<header class="topbar"><div class="identity"><div class="brand-icon" aria-hidden="true">♥</div><div>
       <h1 class="app-title">家庭血压本</h1><p class="app-subtitle">简单记录，安心查看</p></div></div>
       <button class="btn naked small-btn" data-action="settings" aria-label="打开设置">设置</button></header>
       <div style="margin:-10px 0 20px">${refreshStatus()}</div>`;
  }
  function membersHtml(){
    if(!state.members.length)return '';
    return `<div class="member-bar" role="group" aria-label="选择家庭成员"><span class="member-label">正在查看</span>${state.members.map(m=>
      `<button class="member-chip ${m.id===state.activeId?'active':''}" data-action="switch-member" data-id="${esc(m.id)}" aria-pressed="${m.id===state.activeId}">${esc(m.name)}</button>`).join('')}
      <button class="member-chip" data-action="go-family" aria-label="添加家庭成员">＋ 家人</button></div>`;
  }
  function navHtml(){
    const tabs=[['record','记录','＋'],['trends','趋势','⌁'],['history','历史','▤'],['family','家人','♧']];
    return `<nav class="bottom-nav" aria-label="主导航">${tabs.map(([id,label,icon])=>
      `<button class="nav-button ${state.page===id?'current':''}" data-action="navigate" data-page="${id}" aria-current="${state.page===id?'page':'false'}"><span class="nav-mark" aria-hidden="true">${icon}</span>${label}</button>`).join('')}</nav>`;
  }
  function pendingHtml(){
    if(!state.pending.length)return '';
    return `<div class="card warning-card"><h2>有 ${state.pending.length} 条记录还没同步</h2>
      <p class="lead">它们已保存在这台手机里，网络恢复后可以上传。<strong>请勿清除浏览器数据。</strong></p>
      <div class="btn-row"><button class="btn primary" data-action="sync-pending" ${state.busy?'disabled':''}>立即重试同步</button></div></div>`;
  }
  function recordHtml(){
    const m=member();
    if(!m)return `<section class="card"><h2>先添加一位家人</h2><p class="lead">例如：爸爸、妈妈。之后还可以继续添加。</p><button class="btn primary wide" data-action="go-family">添加家人</button></section>`;
    const records=visibleRecords();const latest=records[0];const d=state.draft;
    const showMedication=m.takes_medicine || (state.editingId && d.medication_status!=='no');
    return `<section class="card soft"><h2>${esc(m.name)}的最近一次记录</h2>${latest?
      `<p class="muted medium" style="margin-bottom:13px">${esc(labelTime(latest))} ${latest._pending?' · 尚未同步':''}</p>
      <div class="kpis"><div class="kpi"><div class="kpi-label">高压</div><div class="kpi-val">${latest.systolic}</div><div class="kpi-unit">mmHg</div></div>
      <div class="kpi"><div class="kpi-label">低压</div><div class="kpi-val">${latest.diastolic}</div><div class="kpi-unit">mmHg</div></div>
      <div class="kpi"><div class="kpi-label">脉搏</div><div class="kpi-val">${latest.pulse}</div><div class="kpi-unit">次/分钟</div></div></div>`:
      '<div class="empty-state">还没有记录，从下面开始填写。</div>'}</section>
      <section class="card" id="entry"><h2>${state.editingId?'修改血压记录':'新增血压记录'}</h2>
      <div class="grid-2"><label class="field"><span class="field-label">测量日期</span><input type="date" name="measured_on" value="${esc(d.measured_on)}" required></label>
      <label class="field"><span class="field-label">测量时间</span><input type="time" name="measured_time" value="${esc(String(d.measured_time).slice(0,5))}" required></label></div>
      <div class="grid-2"><label class="field"><span class="field-label">高压</span><input type="number" name="systolic" inputmode="numeric" pattern="[0-9]*" min="1" max="500" placeholder="例如 128" value="${esc(d.systolic)}" required><span class="input-unit">mmHg</span></label>
      <label class="field"><span class="field-label">低压</span><input type="number" name="diastolic" inputmode="numeric" pattern="[0-9]*" min="1" max="500" placeholder="例如 82" value="${esc(d.diastolic)}" required><span class="input-unit">mmHg</span></label></div>
      <label class="field"><span class="field-label">脉搏</span><input type="number" name="pulse" inputmode="numeric" pattern="[0-9]*" min="1" max="500" placeholder="例如 72" value="${esc(d.pulse)}" required><span class="input-unit">次 / 分钟</span></label>
      ${showMedication?`<div><div class="field-label">这次测量与降压药的关系</div><div class="choices">${[
        ...(d.medication_status==='no'?[['no',MED_LABELS.no]]:[]),
        ['before',MED_LABELS.before],['after',MED_LABELS.after],['missed',MED_LABELS.missed],['unknown',MED_LABELS.unknown]
      ].map(([v,l])=>`<label class="choice ${d.medication_status===v?'selected':''}"><input type="radio" name="medication_status" value="${v}" ${d.medication_status===v?'checked':''}><span>${esc(l)}</span></label>`).join('')}</div></div>`:
      `<p class="notice" style="margin-bottom:18px">${esc(MED_LABELS.no)}（自动记录，无须选择）</p>`}
      <details><summary class="field-label" style="cursor:pointer;padding:12px 0">添加备注（可不填）</summary>
      <label class="field"><span class="field-description">例如：头晕、当天换药、测量时不舒服</span>
      <textarea name="note" placeholder="这里可以补充情况">${esc(d.note)}</textarea></label></details>
      <div style="height:18px"></div>
      <button class="btn primary wide" data-action="save-reading" ${state.busy?'disabled':''}>${state.busy?'正在处理…':(state.editingId?'保存修改':'保存血压记录')}</button>
      ${state.editingId?'<button class="btn secondary wide" style="margin-top:12px" data-action="cancel-edit">取消修改</button>':''}
      <p class="footnote">保存后可直接录入下一次测量。数据不会用于自动调整药量。</p></section>`;
  }

  function histHtml(){
    if(!member())return recordHtml();
    const list=visibleRecords();
    return `<section class="card flat"><h2>${esc(member().name)}的历史记录</h2>
       <div class="btn-row" style="margin-bottom:14px"><button class="btn secondary small-btn" data-action="refresh">刷新</button>
       <button class="btn secondary small-btn" data-action="export-member">导出 Excel 可打开的 CSV</button></div>
       <p class="helper">共 ${list.length} 条；按照测量时间从新到旧排列。</p>
       ${list.length?list.map(r=>`<article class="record-card"><div class="record-top"><time>${esc(labelTime(r))}</time>${r._pending?'<span class="status warn">未同步</span>':''}</div>
        <div class="record-numbers">${r.systolic} / ${r.diastolic} <span class="muted medium">mmHg</span></div>
        <p class="lead" style="margin:0 0 12px">脉搏 ${r.pulse} 次/分钟</p>
        <span class="med-tag ${r.medication_status==='missed'?'alert':''}">${esc(MED_LABELS[r.medication_status]||'未记录服药状态')}</span>
        ${r.note?`<p class="record-note">备注：${esc(r.note)}</p>`:''}
        <div class="btn-row" style="margin-top:14px"><button class="btn secondary small-btn" data-action="edit-reading" data-id="${esc(r.id)}">修改</button>
        <button class="btn danger small-btn" data-action="ask-delete" data-id="${esc(r.id)}">删除</button></div></article>`).join(''):
       '<div class="empty-state">暂无历史记录。</div>'}
     </section>`;
  }
  function filteredReadings(){
    const list=visibleRecords().filter(r=>{
      const date=String(r.measured_on);
      if(state.filters.range!=='all'){
        const d=new Date(today()+'T00:00:00');d.setDate(d.getDate()-Number(state.filters.range)+1);
        if(date<`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`)return false;
      }
      const hour=Number(String(r.measured_time).slice(0,2));
      if(state.filters.part==='morning')return hour>=4&&hour<12;
      if(state.filters.part==='evening')return hour>=17;
      return true;
    });return list.reverse();
  }
  function trendsHtml(){
    if(!member())return recordHtml();
    const rows=filteredReadings();
    return `<section class="card"><h2>${esc(member().name)}的血压趋势</h2>
      <div class="field-label" style="margin-bottom:9px">查看时间范围</div>
      <div class="segmented">${[['7','7天'],['30','30天'],['90','90天'],['all','全部']].map(([v,l])=>
        `<button class="btn ${state.filters.range===v?'primary':'secondary'}" data-action="filter-range" data-value="${v}" aria-pressed="${state.filters.range===v}">${l}</button>`).join('')}</div>
      <div class="field-label" style="margin:9px 0">按测量时间筛选</div>
      <div class="segmented">${[['all','所有时间'],['morning','早晨'],['evening','晚上']].map(([v,l])=>
        `<button class="btn ${state.filters.part===v?'primary':'secondary'}" data-action="filter-part" data-value="${v}" aria-pressed="${state.filters.part===v}">${l}</button>`).join('')}</div>
      ${rows.length?`<div class="chart-panel"><h3>血压（mmHg）</h3>
        <div class="chart-legend"><span><i class="legend-dot" style="background:#bf534d"></i>高压</span>
        <span><i class="legend-dot" style="background:#2c7391"></i>低压</span></div>
        <div id="pressure-chart"></div></div>
        <div class="chart-panel"><h3>脉搏（次/分钟）</h3>
        <div class="chart-legend"><span><i class="legend-dot" style="background:#21806b"></i>脉搏</span></div>
        <div id="pulse-chart"></div></div>
        <div class="chart-detail" id="chart-detail">点击图上的测量点，查看具体读数及服药情况。</div>
        <p class="footnote">图中方形表示服药后，三角形表示漏服，空心圆表示状态不确定；实心圆表示服药前或平时不服药。服药前后不拆成两条趋势线；测量时段也会影响读数，不应仅凭图表判断药效。图中包含当前手机尚未同步的记录时，请以同步后的结果为准。</p>`:
        '<div class="empty-state" style="margin-top:15px">这个范围内没有记录，可以换个时间范围看看。</div>'}
     </section>`;
  }
  function familyHtml(){
    return `<section class="card"><h2>家庭成员</h2><p class="lead muted">每台手机会记住选中的家人。爸爸妈妈可以互相查看记录。</p>
      ${state.members.map(m=>`<div class="record-card"><div class="record-top"><strong style="font-size:24px">${esc(m.name)}</strong>${m.id===state.activeId?'<span class="status">本机默认</span>':''}</div>
        <p class="lead">${m.takes_medicine?'目前正在长期服用降压药':'平时不服用降压药'}</p>
        ${state.memberEditorId===m.id?`<div class="field"><label class="field-label" for="edit-name">家人的称呼</label><input id="edit-name" name="editName" value="${esc(state.editName)}" maxlength="30"></div>
        <label class="inline-check"><input type="checkbox" name="editMeds" ${state.editMeds?'checked':''}>目前正在长期服用降压药</label>
        <div class="btn-row"><button class="btn primary small-btn" data-action="save-member" data-id="${esc(m.id)}">保存修改</button><button class="btn secondary small-btn" data-action="cancel-member-edit">取消</button></div>`:
        `<div class="btn-row"><button class="btn secondary small-btn" data-action="switch-member" data-id="${esc(m.id)}">查看 / 记录</button>
        <button class="btn secondary small-btn" data-action="edit-member" data-id="${esc(m.id)}">修改资料</button></div>`}</div>`).join('')}
      ${state.addingMember?`<div class="card soft"><h3>添加一位家人</h3>
         <label class="field"><span class="field-label">称呼</span><input name="newName" maxlength="30" placeholder="例如：奶奶" value="${esc(state.newName)}"></label>
         <label class="inline-check"><input type="checkbox" name="newMeds" ${state.newMeds?'checked':''}>目前正在长期服用降压药</label>
         <div class="btn-row"><button class="btn primary" data-action="add-member" ${state.busy?'disabled':''}>确认添加</button>
         <button class="btn secondary" data-action="cancel-add">取消</button></div></div>`:
      '<button class="btn primary wide" data-action="show-add">＋ 添加家人</button>'}
      <p class="footnote">新家人直接在这里添加，不需要改代码、数据库或重新部署。修改服药情况不会改变过去的记录。</p>
    </section>`;
  }
  function settingsHtml(){
    return `<section class="card"><div class="btn-row" style="justify-content:flex-start"><button class="btn secondary small-btn" data-action="go-back">← 返回</button></div>
      <h2 style="margin-top:18px">设置</h2>
      <div class="settings-row"><div><div class="field-label">界面文字</div><p class="helper" style="margin:4px 0">给看近处文字费力的家人使用</p></div>
      <button class="btn secondary" data-action="toggle-font">${sizeLabel(state.fontXL)} · 点击切换</button></div>
      <div class="settings-row"><div><div class="field-label">刷新家庭记录</div><p class="helper" style="margin:4px 0">从云端重新读取最新记录</p></div>
      <button class="btn secondary" data-action="refresh">刷新</button></div>
      <div class="settings-row"><div><div class="field-label">导出全家记录</div><p class="helper" style="margin:4px 0">CSV 文件可使用 Excel 打开</p></div>
      <button class="btn secondary" data-action="export-all">导出</button></div>
      ${state.cloudMode?`<div class="settings-row"><div><div class="field-label">家庭账号</div><p class="helper" style="margin:4px 0">${esc(backend.user?.email||'已登录')}</p></div><button class="btn danger" data-action="ask-logout">退出登录</button></div>`:''}
    </section>
    <section class="card"><h2>Supabase 云端连接</h2>
      <p class="lead">${state.cloudMode?'已配置项目地址。下面可以测试真实写入和读取。':'当前是演示模式。填好项目地址和 Publishable Key 才会连接云端。'}</p>
      <label class="field"><span class="field-label">Project URL</span>
        <input name="connectingUrl" type="url" autocomplete="off" placeholder="https://xxxx.supabase.co" value="${esc(state.connectingUrl)}"></label>
      <label class="field"><span class="field-label">Publishable Key</span>
        <input name="connectingKey" type="text" autocomplete="off" spellcheck="false" placeholder="sb_publishable_..." value="${esc(state.connectingKey)}"></label>
      <button class="btn secondary wide" data-action="save-config">保存项目配置并切换模式</button>
      <p class="footnote">这里只接受公开 Publishable Key，绝对不要填写 Secret Key。配置只保存在这台设备的浏览器中；正式部署时可以统一写入 config.js，让家人无需重复填写。</p>
      ${state.cloudMode?`<div class="divider"></div><h3>两台手机同步测试</h3>
       <p class="lead">在第一台手机点击“写入并读取”，记住显示的 6 位数字；在第二台手机登录相同家庭账号，点击“读取最新测试标记”。两边一致，才证明跨设备同步。</p>
       <div class="btn-row"><button class="btn primary" data-action="write-check" ${state.busy?'disabled':''}>① 写入并读取</button>
       <button class="btn secondary" data-action="read-check" ${state.busy?'disabled':''}>② 读取最新标记</button></div>
       ${state.testCode?`<p class="lead">本机写入的代码：<span class="sync-test-value">${esc(state.testCode)}</span></p>`:''}
       ${state.lastRemoteTest?`<div class="notice">云端最新代码：<span class="sync-test-value">${esc(state.lastRemoteTest.code)}</span><br><span class="small">时间：${esc(new Date(state.lastRemoteTest.created_at).toLocaleString('zh-CN'))}</span></div>`:''}`:''}
    </section>`;
  }
  function authHtml(){
    return `<main class="auth-page"><div class="identity" style="margin:0 0 25px"><div class="brand-icon">♥</div><div><h1 class="app-title">家庭血压本</h1><p class="app-subtitle">简单记录，安心查看</p></div></div>
      ${noticeHtml()}<section class="card"><h1>${state.signup?'首次创建家庭账号':'登录家庭账号'}</h1>
      <p>全家共用一个登录账号，各自使用不同的成员档案。登录一次后，这台手机会记住账号。</p>
      <label class="field"><span class="field-label">邮箱</span><input type="email" autocomplete="username" name="authEmail" placeholder="name@example.com" value="${esc(state.authEmail)}"></label>
      <label class="field"><span class="field-label">密码</span><input type="password" autocomplete="${state.signup?'new-password':'current-password'}" name="authPassword" placeholder="输入家庭账号密码" value="${esc(state.authPassword)}"></label>
      <button class="btn primary wide" data-action="${state.signup?'signup':'login'}" ${state.busy?'disabled':''}>${state.busy?'正在连接…':state.signup?'创建家庭账号':'登录'}</button>
      <button class="btn naked wide" data-action="toggle-signup">${state.signup?'已经创建过？返回登录':'还没有家庭账号？首次创建'}</button>
      <p class="footnote">注册可能需要验证一次邮箱；之后新增家庭成员不需要再创建登录账号。</p></section>
      <div class="btn-row"><button class="btn secondary" data-action="settings">修改 Supabase 配置</button></div>
    </main>`;
  }
  function modalHtml(){
    if(state.delId){
      return `<div class="modal-overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="确认删除"><h2>确定删除这条记录？</h2>
        <p>删除后将从云端同步移除，不能撤销。</p><div class="btn-row"><button class="btn danger" data-action="confirm-delete">确定删除</button>
        <button class="btn secondary" data-action="cancel-dialog">取消</button></div></div></div>`;
    }
    if(state.saveUnusual){
      return `<div class="modal-overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="确认读数"><h2>请核对这次读数</h2>
        <p>高压 ${esc(state.draft.systolic)}、低压 ${esc(state.draft.diastolic)}、脉搏 ${esc(state.draft.pulse)}。</p>
        <p>数值比较特别，可能有录入错误。如果确实是血压计显示的数字，仍然可以保存。</p>
        <div class="btn-row"><button class="btn primary" data-action="confirm-unusual">确认读数，继续保存</button>
        <button class="btn secondary" data-action="cancel-dialog">返回修改</button></div></div></div>`;
    }
    if(state.showLogout){
      return `<div class="modal-overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="退出登录"><h2>退出家庭账号？</h2>
       <p>退出后需要再次输入家庭账号密码。未同步的记录仍留在这台设备上，但请先同步再退出。</p>
       <div class="btn-row"><button class="btn danger" data-action="confirm-logout">退出登录</button><button class="btn secondary" data-action="cancel-dialog">取消</button></div></div></div>`;
    }
    return '';
  }

  function render(){
    ROOT.className=state.fontXL?'font-xl':'';
    if(state.cloudMode&&!backend.user&&state.page!=='settings'){
      ROOT.innerHTML=authHtml();return;
    }
    const body=state.page==='settings'?settingsHtml():state.page==='record'?recordHtml():state.page==='trends'?trendsHtml():state.page==='history'?histHtml():familyHtml();
    ROOT.innerHTML=`${topHtml()}${state.page==='settings'?'':membersHtml()}${noticeHtml()}${state.page==='settings'?'':pendingHtml()}
       <main id="main-content">${body}</main>${state.page==='settings'?'':navHtml()}${modalHtml()}`;
    if(state.page==='trends')requestAnimationFrame(drawCharts);
  }

  function marker(x,y,color,status) {
    const c=`fill="${color}" stroke="white" stroke-width="2"`;
    if(status==='after')return `<rect x="${x-7}" y="${y-7}" width="14" height="14" rx="2" ${c}/>`;
    if(status==='missed')return `<path d="M ${x} ${y-9} L ${x+9} ${y+8} L ${x-9} ${y+8} Z" ${c}/>`;
    if(status==='unknown')return `<circle cx="${x}" cy="${y}" r="7" fill="white" stroke="${color}" stroke-width="3"/>`;
    return `<circle cx="${x}" cy="${y}" r="7" ${c}/>`;
  }
  function chartSvg(rows,metrics,elementId){
    const el=document.getElementById(elementId);if(!el)return;
    const width=Math.max(el.clientWidth||350,300),height=290,margin={left:54,right:17,top:16,bottom:51};
    const pw=width-margin.left-margin.right,ph=height-margin.top-margin.bottom;
    const times=rows.map(r=>new Date(`${r.measured_on}T${String(r.measured_time).slice(0,5)}:00`).getTime());
    let xMin=Math.min(...times),xMax=Math.max(...times);
    if(xMin===xMax){xMin-=86400000;xMax+=86400000;}
    const vals=rows.flatMap(r=>metrics.map(m=>Number(r[m.key])));
    let vmin=Math.min(...vals),vmax=Math.max(...vals);let span=Math.max(vmax-vmin,20);
    vmin=Math.max(0,Math.floor((vmin-span*.18)/10)*10);
    vmax=Math.ceil((vmax+span*.18)/10)*10;if(vmax<=vmin)vmax=vmin+10;
    const x=t=>margin.left+(t-xMin)/(xMax-xMin)*pw;
    const y=v=>margin.top+(vmax-v)/(vmax-vmin)*ph;
    let svg=`<svg class="chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" aria-label="${esc(metrics.map(m=>m.label).join('和'))}折线图" role="img">`;
    for(let i=0;i<=4;i++){
      const vv=vmin+(vmax-vmin)*(4-i)/4;const yy=margin.top+i*ph/4;
      svg+=`<line x1="${margin.left}" x2="${width-margin.right}" y1="${yy}" y2="${yy}" stroke="#dce7e2" stroke-width="1"/>
       <text x="${margin.left-9}" y="${yy+6}" font-size="18" text-anchor="end" fill="#54676a">${Math.round(vv)}</text>`;
    }
    const tickIdx=Array.from(new Set([0,Math.floor((rows.length-1)/2),rows.length-1]));
    for(const idx of tickIdx){
      const r=rows[idx];const xx=Math.max(30,Math.min(width-31,x(times[idx])));
      svg+=`<text x="${xx}" y="${height-20}" font-size="18" text-anchor="middle" fill="#52666a">${esc(String(r.measured_on).slice(5).replace('-','/'))}</text>`;
    }
    metrics.forEach(m=>{
      const d=rows.map((r,i)=>`${i?'L':'M'} ${x(times[i]).toFixed(1)} ${y(Number(r[m.key])).toFixed(1)}`).join(' ');
      svg+=`<path d="${d}" stroke="${m.color}" stroke-width="3" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
      rows.forEach((r,i)=>{
        const xx=x(times[i]),yy=y(Number(r[m.key]));
        svg+=marker(xx,yy,m.color,r.medication_status);
        svg+=`<circle cx="${xx}" cy="${yy}" r="17" fill="transparent" stroke="none" data-action="point" data-id="${esc(r.id)}" role="button" tabindex="0" aria-label="查看${esc(labelTime(r))}的${m.label}读数" style="cursor:pointer"/>`;
      });
    });
    svg+='</svg>';el.innerHTML=svg;
  }
  function drawCharts(){
    const rows=filteredReadings();if(!rows.length)return;
    chartSvg(rows,[{key:'systolic',label:'高压',color:'#bf534d'},{key:'diastolic',label:'低压',color:'#2c7391'}],'pressure-chart');
    chartSvg(rows,[{key:'pulse',label:'脉搏',color:'#21806b'}],'pulse-chart');
    if(state.selectedPoint)showPoint(state.selectedPoint);
  }
  function showPoint(id){
    const r=visibleRecords().find(x=>x.id===id);const div=document.getElementById('chart-detail');
    if(!r||!div)return;
    div.innerHTML=`<strong>${esc(labelTime(r))}</strong><br>高压 ${r.systolic}、低压 ${r.diastolic} mmHg；脉搏 ${r.pulse} 次/分钟。<br>
      <strong>${esc(MED_LABELS[r.medication_status]||'未记录服药状态')}</strong>${r.note?`<br>备注：${esc(r.note)}`:''}${r._pending?'<br>这条记录还未同步':''}`;
  }
  function validDraft(){
    const d=state.draft;const sys=Number(d.systolic),dia=Number(d.diastolic),pul=Number(d.pulse);
    if(!d.measured_on||!/^\d{4}-\d{2}-\d{2}$/.test(d.measured_on)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(d.measured_time).slice(0,5)))
      throw new RequestError('请填写有效的日期和测量时间');
    if(![d.systolic,d.diastolic,d.pulse].every(v=>/^\d+$/.test(String(v)))||![sys,dia,pul].every(v=>v>0&&v<=500))
      throw new RequestError('高压、低压和脉搏都需要填写 1–500 的整数');
    if(!member())throw new RequestError('请先选择家人');
    if(new Date(`${d.measured_on}T${String(d.measured_time).slice(0,5)}:00`).getTime()>Date.now()+10*60*1000)
      throw new RequestError('测量时间不能设置在未来，请检查日期和时间');
    return {sys,dia,pul};
  }
  function unusualDraft(){
    const d=state.draft;const s=Number(d.systolic),di=Number(d.diastolic),p=Number(d.pulse);
    return s<=di||s>220||s<80||di>130||di<40||p>130||p<45;
  }
  async function saveReading(force=false) {
    if(state.busy)return;
    try{validDraft();}catch(e){say(friendlyError(e),'error');return;}
    if(unusualDraft()&&!force){state.saveUnusual=true;render();return;}
    state.saveUnusual=false;
    const d=state.draft;const id=state.editingId||uid();
    const item={id,member_id:state.activeId,measured_on:d.measured_on,
      measured_time:String(d.measured_time).slice(0,5),systolic:Number(d.systolic),
      diastolic:Number(d.diastolic),pulse:Number(d.pulse),
      medication_status:member().takes_medicine||state.editingId?d.medication_status:'no',
      note:String(d.note||'').trim()};
    if(state.editingPending){
      const idx=state.pending.findIndex(x=>x.id===id);
      if(idx>=0)state.pending[idx]=item;keepPending();
      state.editingPending=false;state.editingId=null;state.draft=freshDraft();keepDraft();
      say('未同步记录已修改并保存在这台设备上。','warn');return;
    }
    state.busy=true;render();
    try {
      await backend.saveMeasurement(item);
      state.draft=freshDraft();state.editingId=null;keepDraft();
      await loadReadings({silent:true});state.busy=false;
      say(state.cloudMode?'已保存到云端，其他家人可以查看。':'已保存到演示数据中。');
    }catch(e){
      state.busy=false;
      if(isNetworkError(e)&&!state.editingId){
        // Do not lose measurements when mobile data disconnects mid-save.
        state.pending.push(item);keepPending();state.draft=freshDraft();keepDraft();state.offline=true;
        say('云端未确认保存。这条记录已留在本机，恢复网络后点击“立即重试同步”。','warn');
      }else{
        keepDraft();say(`未保存成功：${friendlyError(e)}。输入内容已保留。`,'error');
      }
    }
  }
  async function syncPending(){
    if(!state.pending.length){say('当前没有等待同步的记录。');return;}
    if(!state.cloudMode){say('演示模式没有云端同步。','warn');return;}
    state.busy=true;render();let done=0;
    for(const p of [...state.pending]){
      try {await backend.saveMeasurement(p);state.pending=state.pending.filter(x=>x.id!==p.id);keepPending();done++;}
      catch(e){state.busy=false;state.offline=isNetworkError(e);say(`已同步 ${done} 条，剩余 ${state.pending.length} 条：${friendlyError(e)}`,'warn');return;}
    }
    await loadReadings({silent:true});state.busy=false;state.offline=false;
    say(`已将 ${done} 条待同步记录上传到云端。`);
  }
  function startEdit(id){
    const r=visibleRecords().find(x=>x.id===id);if(!r)return;
    state.editingId=r.id;state.editingPending=!!r._pending;
    state.draft={measured_on:r.measured_on,measured_time:String(r.measured_time).slice(0,5),
      systolic:String(r.systolic),diastolic:String(r.diastolic),pulse:String(r.pulse),medication_status:r.medication_status,note:r.note||''};
    keepDraft();state.page='record';clearNotice();render();document.getElementById('entry')?.scrollIntoView({behavior:'smooth'});
  }
  async function doDelete(){
    const id=state.delId;state.delId=null;if(!id)return;
    if(state.pending.some(x=>x.id===id)){
      state.pending=state.pending.filter(x=>x.id!==id);keepPending();say('已删除本机尚未同步的记录。');return;
    }
    state.busy=true;render();
    try {await backend.deleteMeasurement(id);await loadReadings({silent:true});state.busy=false;say('记录已删除。');}
    catch(e){state.busy=false;say(`删除失败：${friendlyError(e)}`,'error');}
  }
  async function addMember(){
    const name=state.newName.trim();if(!name){say('请先填写家人的称呼。','error');return;}
    if(name.length>30){say('称呼不能超过30个字。','error');return;}
    state.busy=true;render();
    try{
      const m=await backend.addMember({name,takes_medicine:state.newMeds});
      state.members.push(m);saveStored(cacheKey('members'),state.members);
      state.newName='';state.newMeds=false;state.addingMember=false;state.busy=false;
      await switchMember(m.id);say(`${name}已经添加好，以后无需修改程序。`);
    }catch(e){state.busy=false;say(`添加失败：${friendlyError(e)}`,'error');}
  }
  async function saveMember(id){
    const name=state.editName.trim();if(!name){say('称呼不能为空。','error');return;}
    state.busy=true;render();
    try{
      const m=await backend.updateMember(id,{name,takes_medicine:state.editMeds});
      state.members=state.members.map(x=>x.id===id?m:x);saveStored(cacheKey('members'),state.members);
      state.memberEditorId=null;state.busy=false;say('家人资料已更新；过去的血压记录不会被修改。');
    }catch(e){state.busy=false;say(`修改失败：${friendlyError(e)}`,'error');}
  }
  function csvSafe(v){
    let str=String(v??'');
    if(/^[=+@\t\r-]/.test(str))str="'"+str;
    return '"'+str.replaceAll('"','""')+'"';
  }
  async function doExport(all){
    let content=[];
    try{
      if(all){
        state.busy=true;render();
        for(const m of state.members){
          const items=m.id===state.activeId?visibleRecords():[
            ...(await backend.listMeasurements(m.id)),...state.pending.filter(x=>x.member_id===m.id).map(x=>({...x,_pending:true}))];
          content.push(...items.map(r=>({...r,displayName:m.name})));
        }
        state.busy=false;
      } else content=visibleRecords().map(r=>({...r,displayName:member()?.name||''}));
      const lines=[['家人','日期','时间','高压(mmHg)','低压(mmHg)','脉搏(次/分钟)','降压药情况','备注','同步状态'],
        ...sortRecords(content).map(r=>[r.displayName,r.measured_on,String(r.measured_time).slice(0,5),r.systolic,r.diastolic,r.pulse,MED_LABELS[r.medication_status]||'',r.note||'',r._pending?'未同步':'已同步'])];
      const text='\uFEFF'+lines.map(row=>row.map(csvSafe).join(',')).join('\r\n');
      const obj=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));
      const a=document.createElement('a');a.href=obj;a.download=`家庭血压记录_${all?'全家':member()?.name||'成员'}_${today()}.csv`;
      document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(obj),5000);
      say(`CSV 文件已生成（${content.length} 条记录）。`);
    }catch(e){state.busy=false;say(`导出失败：${friendlyError(e)}`,'error');}
  }
  async function writeCheck(){
    state.busy=true;render();
    const nums=new Uint32Array(1);crypto.getRandomValues(nums);const code=String(nums[0]%1000000).padStart(6,'0');
    try{
      const saved=await backend.writeCheck(code);
      const fetched=await backend.readLatestCheck();
      if(fetched?.id!==saved.id||fetched?.code!==code)throw new RequestError('写入成功，但读取到的数据不一致');
      state.testCode=code;state.lastRemoteTest=fetched;localStorage.setItem(`${scope()}:test-code`,code);
      state.busy=false;state.offline=false;
      say(`真实写入和读取均成功，代码 ${code}。请在另一部手机检查。`);
    }catch(e){state.busy=false;state.offline=isNetworkError(e);say(`连接测试没有通过：${friendlyError(e)}`,'error');}
  }
  async function readCheck(){
    state.busy=true;render();
    try{
      const found=await backend.readLatestCheck();state.lastRemoteTest=found;state.busy=false;
      say(found?`云端最新的测试代码是 ${found.code}，请与另一台手机核对。`:'云端还没有测试标记。','success');
    }catch(e){state.busy=false;say(`读取失败：${friendlyError(e)}`,'error');}
  }
  async function authenticate(signup){
    const email=state.authEmail.trim(),password=state.authPassword;
    if(!/^\S+@\S+\.\S+$/.test(email)){say('请填写有效的邮箱地址。','error');return;}
    if(password.length<6){say('密码至少6位。','error');return;}
    state.busy=true;render();
    try{
      if(signup){
        const out=await backend.signup(email,password);state.busy=false;state.authPassword='';
        if(!out.loggedIn){state.signup=false;say('家庭账号已提交注册。请检查邮箱验证邮件，验证后回到这里登录。','success');return;}
      }else await backend.signIn(email,password);
      state.authPassword='';state.pending=parseStored(pendingKey(),[]);
      state.activeId=localStorage.getItem(`${scope()}:default-member`)||null;
      state.page='record';await loadMembers();await loadReadings();state.busy=false;
      say('家庭账号已登录，可以开始记录。');
    }catch(e){state.busy=false;say(`登录失败：${friendlyError(e)}`,'error');}
  }
  async function saveConfig(){
    try{
      const clean=validateConfig(state.connectingUrl,state.connectingKey);
      saveStored(CLOUD_SETTINGS_KEY,{url:clean.url,key:clean.key});
      location.reload();
    }catch(e){say(friendlyError(e),'error');}
  }
  function onInputs(event){
    const t=event.target;if(!t.name)return;
    if(t.name in state.draft){
      state.draft[t.name]=t.value;keepDraft();
      if(t.name==='medication_status'){
        document.querySelectorAll('.choice').forEach(el=>el.classList.toggle('selected',el.querySelector('input')?.checked));
      }
    }else if(t.name==='newName')state.newName=t.value;
    else if(t.name==='newMeds')state.newMeds=t.checked;
    else if(t.name==='editName')state.editName=t.value;
    else if(t.name==='editMeds')state.editMeds=t.checked;
    else if(t.name==='authEmail')state.authEmail=t.value;
    else if(t.name==='authPassword')state.authPassword=t.value;
    else if(t.name==='connectingUrl')state.connectingUrl=t.value;
    else if(t.name==='connectingKey')state.connectingKey=t.value;
  }
  async function onClick(event){
    const t=event.target.closest('[data-action]');if(!t)return;
    const action=t.dataset.action;const id=t.dataset.id;const value=t.dataset.value;
    if(state.busy&&!['cancel-dialog'].includes(action))return;
    switch(action){
      case 'navigate':state.page=t.dataset.page;state.selectedPoint=null;clearNotice();render();window.scrollTo({top:0,behavior:'smooth'});break;
      case 'settings':state.page='settings';clearNotice();render();window.scrollTo({top:0});break;
      case 'go-back':state.page='record';render();break;
      case 'go-family':state.page='family';clearNotice();render();break;
      case 'switch-member':await switchMember(id);break;
      case 'refresh':await reload();break;
      case 'save-reading':await saveReading();break;
      case 'confirm-unusual':await saveReading(true);break;
      case 'cancel-edit':state.editingId=null;state.editingPending=false;state.draft=freshDraft();keepDraft();clearNotice();render();break;
      case 'ask-delete':state.delId=id;render();break;
      case 'confirm-delete':await doDelete();break;
      case 'cancel-dialog':state.delId=null;state.saveUnusual=false;state.showLogout=false;render();break;
      case 'edit-reading':startEdit(id);break;
      case 'sync-pending':await syncPending();break;
      case 'filter-range':state.filters.range=value;saveStored(FILTERS_KEY,state.filters);state.selectedPoint=null;render();break;
      case 'filter-part':state.filters.part=value;saveStored(FILTERS_KEY,state.filters);state.selectedPoint=null;render();break;
      case 'point':state.selectedPoint=id;showPoint(id);break;
      case 'show-add':state.addingMember=true;render();break;
      case 'cancel-add':state.addingMember=false;render();break;
      case 'add-member':await addMember();break;
      case 'edit-member':{const m=state.members.find(x=>x.id===id);if(m){state.memberEditorId=id;state.editName=m.name;state.editMeds=m.takes_medicine;render();}break;}
      case 'save-member':await saveMember(id);break;
      case 'cancel-member-edit':state.memberEditorId=null;render();break;
      case 'export-member':await doExport(false);break;
      case 'export-all':await doExport(true);break;
      case 'toggle-font':state.fontXL=!state.fontXL;saveStored(FONT_KEY,state.fontXL);render();break;
      case 'save-config':await saveConfig();break;
      case 'write-check':await writeCheck();break;
      case 'read-check':await readCheck();break;
      case 'toggle-signup':state.signup=!state.signup;clearNotice();render();break;
      case 'signup':await authenticate(true);break;
      case 'login':await authenticate(false);break;
      case 'ask-logout':state.showLogout=true;render();break;
      case 'confirm-logout':backend.signOut();state.showLogout=false;state.members=[];state.readings=[];state.pending=[];state.page='record';clearNotice();render();break;
    }
  }
  ROOT.addEventListener('input',onInputs);
  ROOT.addEventListener('change',onInputs);
  ROOT.addEventListener('click',onClick);
  ROOT.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&e.target.matches('[data-action="point"]'))onClick({target:e.target});
  });
  window.addEventListener('resize',()=>{if(state.page==='trends')drawCharts();});
  const refreshQuietly=()=>{
    if(!backend.user||state.busy||state.page==='settings'||document.visibilityState!=='visible')return;
    // Never interrupt someone who is entering or editing a blood-pressure reading.
    if(state.page==='record'&&(state.editingId||state.draft.systolic||state.draft.diastolic||state.draft.pulse))return;
    if(state.page==='record'){
      state.draft.measured_on=today();state.draft.measured_time=nowTime();keepDraft();
    }
    reload({silent:true});
  };
  document.addEventListener('visibilitychange',refreshQuietly);
  setInterval(refreshQuietly,60000);
  window.addEventListener('online',()=>{
    if(backend.user&&!state.busy){
      if(state.pending.length)syncPending(); else refreshQuietly();
    }
  });
  if(location.protocol==='https:'&&'serviceWorker' in navigator){
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
  async function init(){
    if(backend.user){
      state.loading=true;
      await loadMembers();await loadReadings();
      state.loading=false;
    }
    render();
  }
  init();
})();
