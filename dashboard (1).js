function esc(s){
  if(s==null)return'';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

const PAGE_META={
  overview:{title:'نظرة عامة',sub:'إحصائيات البوت الكاملة'},
  qr:{title:'ربط واتساب',sub:'امسح رمز QR لربط الجهاز'},
  users:{title:'المستخدمون',sub:'إدارة وصلاحيات كل مستخدم'},
  conversations:{title:'المحادثات',sub:'عرض كل المحادثات بين المستخدمين والبوت'},
  usage:{title:'الاستهلاك اليومي',sub:'تقرير استهلاك الرسائل والصور والملفات'},
  limits:{title:'حدود الرسائل',sub:'تخصيص الحد اليومي لكل مستخدم'},
  vip:{title:'أعضاء VIP',sub:'مستخدمون بصلاحيات غير محدودة'},
  customsend:{title:'رسالة مخصصة',sub:'إرسال رسالة مباشرة لمستخدم محدد'},
  blacklist:{title:'المحظورون',sub:'قائمة المحظورين من استخدام البوت'},
  broadcast:{title:'البث الجماعي',sub:'إرسال رسالة لجميع المستخدمين'},
  targeted:{title:'المستخدمون المستهدفون',sub:'من انتهت فترتهم التجريبية ولم يشتركوا'},
  reports:{title:'البلاغات',sub:'البلاغات المرسلة من المستخدمين'}
};

let _data=null;

function showTab(name){
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');
  const m=PAGE_META[name]||{title:name,sub:''};
  document.getElementById('page-title').textContent=m.title;
  document.getElementById('page-sub').textContent=m.sub;
  if(_data)updateUI();
  // جلب بيانات الاستهلاك التفصيلية فقط عند فتح تبويب الاستهلاك (لتسريع التحميل الأولي)
  if(name==='usage' && _data && !_data.userUsage){
    fetch('/data/usage',{credentials:'include'}).then(r=>r.json()).then(u=>{
      if(u.userUsage){_data.userUsage=u.userUsage;renderUsage(_data);}
    }).catch(()=>{});
  }
}

function toast(msg,color){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.style.background=color||'#16a34a';
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),3000);
}

async function api(action,data={}){
  try{
    const r=await fetch('/api',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,data})});
    if(r.status===401){window.location.href='/login';return{ok:false};}
    return await r.json();
  }catch(e){toast('خطأ في الاتصال','#dc2626');return{ok:false};}
}

async function loadData(){
  try{
    const r=await fetch('/data',{credentials:'include'});
    if(r.status===401){window.location.href='/login';return;}
    _data=await r.json();
    updateUI();
    document.getElementById('last-updated').textContent=new Date().toLocaleTimeString('ar');
  }catch(e){console.error(e);}
}

function updateUI(){
  if(!_data)return;
  const d=_data;
  const s=d.stats;

  // sidebar status
  const dot=document.getElementById('dot');
  const lbl=document.getElementById('conn-label');
  dot.className='dot'+(d.connected?' on':'');
  lbl.textContent=d.connected?'متصل':'غير متصل';

  // stats
  setText('s-users',s.users);setText('s-active',s.active);setText('s-vip',s.vip);
  setText('s-msgs',s.messages);setText('s-imgs',s.images);setText('s-docs',s.docs);
  setText('s-med',s.medical);setText('s-rep',s.reports);

  // reports badge
  const rb=document.getElementById('reports-badge');
  if(s.reports>0){rb.style.display='inline';rb.textContent=s.reports;}else{rb.style.display='none';}

  // system info
  const sysSt=document.getElementById('sys-status');
  if(sysSt)sysSt.innerHTML=d.connected?'<span class="badge badge-green">✅ متصل وشغال</span>':'<span class="badge badge-red">❌ غير متصل</span>';
  const sysBlocked=document.getElementById('sys-blocked');
  if(sysBlocked)sysBlocked.textContent=s.users>0?(((d.blacklist||[]).length/s.users*100).toFixed(1)+'%'):'0%';
  const sysDeflimit=document.getElementById('sys-deflimit');
  if(sysDeflimit)sysDeflimit.innerHTML='<span class="badge badge-blue">'+(d.defaultLimit||20)+' رسالة/يوم</span>';
  const sysVipPct=document.getElementById('sys-vippct');
  if(sysVipPct)sysVipPct.textContent=s.users>0?((s.vip/s.users*100).toFixed(1)+'%'):'0%';

  // broadcast count
  const bc=document.getElementById('broadcast-count');
  if(bc)bc.textContent='سيصل لـ '+(Math.max(0,s.users-1))+' مستخدم';

  // default limit label
  const dll=document.getElementById('default-limit-label');
  if(dll)dll.textContent='الحد الافتراضي: '+(d.defaultLimit||20)+' رسالة/يوم';

  // حالة الاتصال (Cloud API متصل دائماً عبر HTTP، لا يوجد QR)
  const qrSec=document.getElementById('qr-section');
  qrSec.innerHTML='<div class="connected-msg">✅ البوت متصل عبر WhatsApp Cloud API الرسمي وجاهز للرد!</div>';

  renderUsers(d);
  renderUsage(d);
  renderLimits(d);
  renderVip(d);
  renderBlacklist(d);
  renderReports(d);
}

function setText(id,val){const el=document.getElementById(id);if(el)el.textContent=val??'—';}

// ── USERS ──
let _allUsers=[];
function renderUsers(d){
  _allUsers=d.welcomedUsers.map(num=>({
    num,
    name:d.userNames[num]||'—',
    isVip:(d.vipNumbers||[]).includes(num),
    isBlocked:(d.blacklist||[]).includes(num),
    usage:null, // لا نحمّل الاستهلاك هنا — يُحمّل فقط عند فتح تبويب الاستهلاك
    customLimit:d.userLimits?d.userLimits[num]:null
  }));
  filterUsers();
}
function filterUsers(){
  const q=(document.getElementById('user-search')?.value||'').toLowerCase();
  const filtered=q?_allUsers.filter(u=>u.num.includes(q)||u.name.toLowerCase().includes(q)):_allUsers;
  const tb=document.getElementById('users-table');
  if(!filtered.length){tb.innerHTML='<tr><td colspan="6" class="empty">لا يوجد مستخدمون</td></tr>';return;}
  tb.innerHTML=filtered.slice(0,200).map(u=>{
    const usage=u.usage||{used:0,limit:20,remaining:20,images:0,docs:0};
    const pct=usage.limit>0?Math.min(100,Math.round(usage.used/usage.limit*100)):0;
    const fillClass=pct>=100?'high':pct>=70?'mid':'low';
    const progHtml=`<div class="prog-wrap"><div class="prog-bar"><div class="prog-fill ${fillClass}" style="width:${pct}%"></div></div><div class="prog-text">${usage.used}/${usage.limit}</div></div>`;
    const customLimitBadge=u.customLimit!=null?`<span class="badge badge-yellow">${u.customLimit}</span>`:'<span class="badge badge-muted">افتراضي</span>';
    const statusBadge=u.isBlocked?'<span class="badge badge-red">⛔ محظور</span>':u.isVip?'<span class="badge badge-blue">⭐ VIP</span>':'<span class="badge badge-green">عادي</span>';
    const vipBtn=u.isVip?`<button class="btn btn-warn" onclick="removeVipNum(${JSON.stringify(u.num)})">إزالة VIP</button>`:`<button class="btn btn-primary" onclick="addVipNum(${JSON.stringify(u.num)})">+ VIP</button>`;
    const blockBtn=u.isBlocked?`<button class="btn btn-success" onclick="removeBlacklistNum(${JSON.stringify(u.num)})">✅ رفع حظر</button>`:`<button class="btn btn-purple" onclick="blockUser(${JSON.stringify(u.num)})">⛔ حظر</button>`;
    return `<tr>
      <td dir="ltr" style="font-family:monospace;color:var(--accent)">${esc(u.num)}</td>
      <td>${esc(u.name)}</td>
      <td>${statusBadge}</td>
      <td>${progHtml}</td>
      <td>${customLimitBadge}</td>
      <td><div class="action-row">
        ${!u.isBlocked?vipBtn:''}
        <button class="btn btn-warn" onclick="quickSetLimit(${JSON.stringify(u.num)})">🔢 حد</button>
        <button class="btn btn-primary" onclick="quickSendMessage(${JSON.stringify(u.num)})">✉️ رسالة</button>
        ${!u.isBlocked?blockBtn:blockBtn}
        <button class="btn btn-danger" onclick="deleteUser(${JSON.stringify(u.num)})">🗑️</button>
      </div></td>
    </tr>`;
  }).join('');
}

// ── USAGE ──
let _allUsage=[];
function renderUsage(d){
  if(!d.userUsage){
    // بيانات الاستهلاك لم تُحمّل بعد — تُطلب عند فتح التبويب
    const tb=document.getElementById('usage-table');
    if(tb)tb.innerHTML='<tr><td colspan="9" class="empty">افتح تبويب الاستهلاك لتحميل البيانات</td></tr>';
    return;
  }
  _allUsage=d.welcomedUsers.map(num=>({
    num,name:d.userNames[num]||'—',
    isVip:(d.vipNumbers||[]).includes(num),
    isBlocked:(d.blacklist||[]).includes(num),
    ...(d.userUsage[num]||{used:0,images:0,docs:0,limit:20,remaining:20,resetAt:null})
  }));
  filterUsage();
}
function filterUsage(){
  const q=(document.getElementById('usage-search')?.value||'').toLowerCase();
  const filt=document.getElementById('usage-filter')?.value||'all';
  let arr=_allUsage;
  if(q)arr=arr.filter(u=>u.num.includes(q)||u.name.toLowerCase().includes(q));
  if(filt==='active')arr=arr.filter(u=>u.used>0||u.images>0||u.docs>0);
  if(filt==='full')arr=arr.filter(u=>u.remaining<=0&&!u.isVip);
  if(filt==='vip')arr=arr.filter(u=>u.isVip);
  arr=arr.slice().sort((a,b)=>b.used-a.used);
  const tb=document.getElementById('usage-table');
  if(!arr.length){tb.innerHTML='<tr><td colspan="9" class="empty">لا توجد بيانات</td></tr>';return;}
  tb.innerHTML=arr.slice(0,200).map(u=>{
    const pct=u.limit>0?Math.min(100,Math.round(u.used/u.limit*100)):0;
    const fillClass=pct>=100?'high':pct>=70?'mid':'low';
    const statusBadge=u.isBlocked?'<span class="badge badge-red">⛔ محظور</span>':u.isVip?'<span class="badge badge-blue">♾️ VIP</span>':u.remaining<=0?'<span class="badge badge-red">🔴 محدود</span>':'<span class="badge badge-green">🟢 نشط</span>';
    const progHtml=`<div class="prog-wrap" style="min-width:100px"><div class="prog-bar"><div class="prog-fill ${fillClass}" style="width:${pct}%"></div></div><div class="prog-text">${pct}%</div></div>`;
    const resetStr=u.resetAt?new Date(u.resetAt).toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'}):'—';
    return `<tr>
      <td dir="ltr" style="font-family:monospace;font-size:11px;color:var(--accent)">${esc(u.num)}</td>
      <td>${esc(u.name)}</td>
      <td>${statusBadge}</td>
      <td style="text-align:center">${u.used}</td>
      <td style="text-align:center">${u.images}</td>
      <td style="text-align:center">${u.docs}</td>
      <td style="text-align:center">${u.isVip?'♾️':u.limit}</td>
      <td style="text-align:center">${u.isVip?'♾️':u.remaining}</td>
      <td>${u.isVip?'<span class="badge badge-blue">غير محدود</span>':progHtml}</td>
    </tr>`;
  }).join('');
}

// ── LIMITS ──
function renderLimits(d){
  const tb=document.getElementById('limits-table');
  const limits=d.userLimits||{};
  const keys=Object.keys(limits);
  if(!keys.length){tb.innerHTML='<tr><td colspan="5" class="empty">لا يوجد حدود مخصصة — الكل على الافتراضي ('+(d.defaultLimit||20)+')</td></tr>';return;}
  tb.innerHTML=keys.map(num=>{
    const usage=d.userUsage?d.userUsage[num]:null;
    const used=usage?usage.used:0;
    const lim=limits[num];
    const pct=lim>0?Math.min(100,Math.round(used/lim*100)):0;
    const fillClass=pct>=100?'high':pct>=70?'mid':'low';
    return `<tr>
      <td dir="ltr" style="font-family:monospace;color:var(--accent)">${esc(num)}</td>
      <td>${esc(d.userNames[num]||'—')}</td>
      <td><span class="badge badge-blue">${lim} رسالة/يوم</span></td>
      <td><div class="prog-wrap"><div class="prog-bar"><div class="prog-fill ${fillClass}" style="width:${pct}%"></div></div><div class="prog-text">${used}/${lim}</div></div></td>
      <td><button class="btn btn-danger" onclick="resetUserLimitNum(${JSON.stringify(num)})">↩️ إعادة</button></td>
    </tr>`;
  }).join('');
}

// ── VIP ──
function renderVip(d){
  const tb=document.getElementById('vip-table');
  if(!d.vipNumbers.length){tb.innerHTML='<tr><td colspan="4" class="empty">لا يوجد أعضاء VIP</td></tr>';return;}
  tb.innerHTML=d.vipNumbers.map(num=>{
    const expiry=d.vipExpiry?d.vipExpiry[num]:null;
    let expiryStr='<span class="badge badge-green">دائم ♾️</span>';
    if(expiry){
      const now=Date.now();
      const diff=expiry-now;
      if(diff<0){expiryStr='<span class="badge badge-red">منتهي ⛔</span>';}
      else{
        const days=Math.ceil(diff/(24*60*60*1000));
        expiryStr='<span class="badge badge-yellow">'+days+' يوم</span>';
      }
    }
    return `<tr>
      <td dir="ltr" style="font-family:monospace;color:var(--accent)">${esc(num)}</td>
      <td>${esc(d.userNames[num]||'—')}</td>
      <td>${expiryStr}</td>
      <td>
        <div class="action-row">
          <button class="btn btn-primary" onclick="renewVip(${JSON.stringify(num)})">🔄 تجديد</button>
          <button class="btn btn-primary" onclick="quickSendMessage(${JSON.stringify(num)})">✉️</button>
          <button class="btn btn-danger" onclick="removeVipNum(${JSON.stringify(num)})">❌ إزالة</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── BLACKLIST ──
function renderBlacklist(d){
  const tb=document.getElementById('blacklist-table');
  const bl=d.blacklist||[];
  if(!bl.length){tb.innerHTML='<tr><td colspan="3" class="empty">لا يوجد مستخدمون محظورون</td></tr>';return;}
  tb.innerHTML=bl.map(num=>{
    return `<tr>
      <td dir="ltr" style="font-family:monospace;color:var(--red)">${esc(num)}</td>
      <td>${esc(d.userNames[num]||'—')}</td>
      <td><button class="btn btn-success" onclick="removeBlacklistNum(${JSON.stringify(num)})">✅ رفع الحظر</button></td>
    </tr>`;
  }).join('');
}

// ── REPORTS ──
function renderReports(d){
  const tb=document.getElementById('reports-table');
  if(!d.reports.length){tb.innerHTML='<tr><td colspan="6" class="empty">لا يوجد بلاغات</td></tr>';return;}
  tb.innerHTML=d.reports.map((r,i)=>{
    return `<tr>
      <td style="color:var(--muted)">${i+1}</td>
      <td>${esc(r.name||'—')}</td>
      <td dir="ltr" style="font-size:11px;font-family:monospace;color:var(--accent)">${esc(r.sender)}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.text)}">${esc(r.text)}</td>
      <td style="font-size:11px;color:var(--muted)">${esc(r.time)}</td>
      <td><button class="btn btn-purple" onclick="blockUser(${JSON.stringify(r.sender)})">⛔ حظر</button></td>
    </tr>`;
  }).join('');
}

// ── ACTIONS ──
async function doAction(action){
  if(action==='clearSessions'&&!confirm('مسح كل الجلسات النشطة؟'))return;
  const r=await api(action);
  toast(r.msg||'✅ تم');
  loadData();
}
async function loadTargetedUsers(){
  document.getElementById('targeted-count').textContent='جاري التحميل...';
  document.getElementById('targeted-table').innerHTML='<tr><td colspan="4" class="empty">جاري التحميل...</td></tr>';
  const r=await api('getTargetedUsers');
  if(!r.ok){toast('❌ '+(r.msg||'فشل'),'#dc2626');return;}
  document.getElementById('targeted-count').textContent='إجمالي المستهدفين: '+r.total+' مستخدم';
  const tbody=document.getElementById('targeted-table');
  if(!r.users||!r.users.length){
    tbody.innerHTML='<tr><td colspan="4" class="empty">لا يوجد مستخدمون مستهدفون حالياً</td></tr>';
    return;
  }
  tbody.innerHTML=r.users.map(u=>
    '<tr>'+
    '<td dir="ltr">'+esc(u.num)+'</td>'+
    '<td>'+esc(u.name)+'</td>'+
    '<td style="color:#ef4444;font-weight:700">'+u.msgs+'</td>'+
    '<td>'+u.limit+'</td>'+
    '</tr>'
  ).join('');
}
async function sendTargetedBroadcast(){
  const text=document.getElementById('targeted-msg-text').value.trim();
  if(!text){toast('أدخل نص الرسالة','#f59e0b');return;}
  const countEl=document.getElementById('targeted-count').textContent;
  if(!confirm('إرسال البث المستهدف؟\n'+countEl))return;
  const r=await api('broadcastTargeted',{text});
  if(r.ok){
    toast('✅ '+r.msg);
    showTab('broadcast');
    startBroadcastPolling();
  } else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function startBroadcast(){
  const text=document.getElementById('broadcast-text').value.trim();
  if(!text){toast('أدخل نص الرسالة','#f59e0b');return;}
  const total=_data?Object.keys(_data.users||{}).length:0;
  if(!confirm('إرسال البث لـ '+total+' مستخدم بدفعات 100؟'))return;
  const r=await api('broadcast',{text});
  if(r.ok){toast('✅ '+r.msg);startBroadcastPolling();}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function toggleBroadcast(){
  const btn=document.getElementById('btn-stop-resume');
  const isRunning=btn.textContent.includes('إيقاف');
  const r=await api(isRunning?'broadcastStop':'broadcastResume');
  if(r.ok)toast('✅ '+r.msg);
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
function clearBroadcastState(){
  if(!confirm('مسح حالة البث؟'))return;
  document.getElementById('broadcast-progress-card').style.display='none';
  if(_bcPollTimer){clearInterval(_bcPollTimer);_bcPollTimer=null;}
}
let _bcPollTimer=null;
function startBroadcastPolling(){
  document.getElementById('broadcast-progress-card').style.display='block';
  if(_bcPollTimer)clearInterval(_bcPollTimer);
  _bcPollTimer=setInterval(updateBroadcastStatus,1500);
  updateBroadcastStatus();
}
async function updateBroadcastStatus(){
  const r=await api('broadcastStatus');
  if(!r.ok||r.status==='idle'){
    if(r.status==='idle'){document.getElementById('broadcast-progress-card').style.display='none';}
    if(_bcPollTimer){clearInterval(_bcPollTimer);_bcPollTimer=null;}
    return;
  }
  document.getElementById('broadcast-progress-card').style.display='block';
  document.getElementById('bc-sent').textContent=r.sent||0;
  document.getElementById('bc-failed').textContent=r.failed||0;
  document.getElementById('bc-remaining').textContent=Math.max(0,(r.total||0)-(r.sent||0)-(r.failed||0));
  document.getElementById('bc-total').textContent=r.total||0;
  document.getElementById('bc-percent').textContent=(r.percent||0)+'%';
  document.getElementById('bc-progress-bar').style.width=(r.percent||0)+'%';
  const btn=document.getElementById('btn-stop-resume');
  if(r.status==='running'){btn.textContent='⏸️ إيقاف';btn.className='btn btn-warn btn-sm';}
  else if(r.status==='paused'){btn.textContent='▶️ استكمال';btn.className='btn btn-success btn-sm';}
  const msgs={running:'🔄 البث جارٍ...',paused:'⏸️ البث متوقف — اضغط استكمال للمتابعة من نفس المكان',done:'✅ اكتمل البث!'};
  document.getElementById('bc-status-msg').textContent=msgs[r.status]||r.status;
  document.getElementById('btn-clear-broadcast').style.display=(r.status==='done'||r.status==='paused')?'':'none';
  const batchesEl=document.getElementById('bc-batches');
  batchesEl.innerHTML='';
  for(let i=0;i<(r.totalBatches||0);i++){
    const div=document.createElement('div');
    let bg='rgba(255,255,255,.1)';
    if(i<r.batchIndex)bg='#25c39e';
    else if(i===r.batchIndex&&r.status==='running')bg='#f59e0b';
    else if(i===r.batchIndex&&r.status==='paused')bg='#6366f1';
    div.style.cssText='background:'+bg+';border-radius:6px;padding:4px 10px;font-size:11px;color:#fff;font-weight:700;transition:background .3s';
    div.textContent='دفعة '+(i+1);
    if(i===r.batchIndex&&r.status==='running')div.textContent+=' ('+r.currentBatchSent+'/'+r.currentBatchTotal+')';
    batchesEl.appendChild(div);
  }
  if(r.status==='done'&&_bcPollTimer){clearInterval(_bcPollTimer);_bcPollTimer=null;}
}
async function blockUser(num){
  if(!confirm('حظر المستخدم '+num+'؟ سيصله إشعار تلقائي.'))return;
  const r=await api('addBlacklist',{num:String(num)});
  if(r.ok){toast('⛔ '+r.msg);loadData();}
  else toast('❌ '+(r.msg||'فشل الحظر'),'#dc2626');
}
async function addBlacklist(){
  const raw=document.getElementById('bl-num').value.trim();
  const num=raw.replace(/\D/g,'');
  if(!num){toast('❌ أدخل رقم هاتف صحيح','#dc2626');return;}
  if(!confirm('حظر المستخدم '+num+'؟ سيصله إشعار تلقائي.'))return;
  const r=await api('addBlacklist',{num});
  if(r.ok){toast('⛔ '+r.msg);document.getElementById('bl-num').value='';loadData();}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function removeBlacklistNum(num){
  if(!confirm('رفع الحظر عن '+num+'؟'))return;
  const r=await api('removeBlacklist',{num:String(num)});
  if(r.ok){toast('✅ '+r.msg);loadData();}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function addVip(){
  const raw=document.getElementById('new-vip').value.trim();
  const num=raw.replace(/\D/g,'');
  if(!num){toast('❌ أدخل رقم هاتف صحيح','#dc2626');return;}
  const r=await api('addVip',{num});
  if(r.ok){toast('⭐ '+r.msg);document.getElementById('new-vip').value='';loadData();}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function addVipNum(num){
  if(!confirm('تفعيل VIP للمستخدم '+num+'؟'))return;
  const r=await api('addVip',{num:String(num)});
  if(r.ok){toast('⭐ '+r.msg);loadData();}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function removeVipNum(num){
  if(!confirm('إزالة '+num+' من VIP؟ سيصله إشعار.'))return;
  const r=await api('removeVip',{num:String(num)});
  if(r.ok){toast('✅ '+r.msg);loadData();}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function deleteUser(num){
  if(!confirm('حذف هذا المستخدم نهائياً؟ لا يمكن التراجع.'))return;
  const r=await api('deleteUser',{num:String(num)});
  if(r.ok){toast('✅ تم الحذف');loadData();}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function clearReports(){
  if(!confirm('مسح كل البلاغات؟'))return;
  const r=await api('clearReports');
  if(r.ok){toast('تم مسح البلاغات');loadData();}
}
async function setUserLimit(){
  const num=document.getElementById('limit-num').value.replace(/\D/g,'');
  const limit=parseInt(document.getElementById('limit-val').value,10);
  if(!num){toast('أدخل رقم الهاتف','#f59e0b');return;}
  if(isNaN(limit)||limit<0){toast('أدخل عدداً صحيحاً','#f59e0b');return;}
  const r=await api('setUserLimit',{num,limit});
  if(r.ok){toast('✅ تم تعيين الحد وإشعار المستخدم');document.getElementById('limit-num').value='';document.getElementById('limit-val').value='';loadData();}
  else toast(r.msg||'فشل','#dc2626');
}
async function resetUserLimit(){
  const num=document.getElementById('limit-num').value.replace(/\D/g,'');
  if(!num){toast('أدخل رقم الهاتف','#f59e0b');return;}
  const r=await api('resetUserLimit',{num});
  if(r.ok){toast('تم الإعادة للافتراضي');loadData();}
}
async function renewVip(num){
  if(!confirm('تجديد VIP للمستخدم '+num+' لشهر إضافي؟'))return;
  const r=await api('addVip',{num:String(num)});
  if(r.ok){toast('✅ '+r.msg);loadData();}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function adjustVipDays(){
  const num=document.getElementById('vip-edit-num').value.replace(/\D/g,'');
  const daysRaw=document.getElementById('vip-edit-days').value.trim();
  if(!num){toast('أدخل رقم الهاتف','#f59e0b');return;}
  if(daysRaw===''){toast('أدخل عدد الأيام (موجب أو سالب)','#f59e0b');return;}
  const days=parseInt(daysRaw,10);
  if(isNaN(days)){toast('عدد أيام غير صحيح','#f59e0b');return;}
  const r=await api('setVipExpiry',{num,mode:'days',days});
  if(r.ok){toast('✅ '+r.msg);document.getElementById('vip-edit-days').value='';loadData();}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function setVipDate(){
  const num=document.getElementById('vip-edit-num').value.replace(/\D/g,'');
  const dateStr=document.getElementById('vip-edit-date').value;
  if(!num){toast('أدخل رقم الهاتف','#f59e0b');return;}
  if(!dateStr){toast('اختر تاريخ الانتهاء','#f59e0b');return;}
  if(!confirm('تعيين تاريخ انتهاء VIP لـ '+num+' إلى '+dateStr+'؟'))return;
  const r=await api('setVipExpiry',{num,mode:'date',dateStr});
  if(r.ok){toast('✅ '+r.msg);loadData();}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
async function sendCustomMessage(){
  const num=document.getElementById('custom-msg-num').value.replace(/\D/g,'');
  const text=document.getElementById('custom-msg-text').value.trim();
  if(!num){toast('أدخل رقم الهاتف','#f59e0b');return;}
  if(!text){toast('أدخل نص الرسالة','#f59e0b');return;}
  const r=await api('sendCustomMessage',{num,text});
  if(r.ok){toast('✅ '+r.msg);document.getElementById('custom-msg-text').value='';}
  else toast('❌ '+(r.msg||'فشل'),'#dc2626');
}
// فتح تبويب الرسالة المخصصة مع تعبئة رقم مستخدم محدد مسبقاً (من زر سريع بجانب أي مستخدم)
function quickSendMessage(num){
  showTab('customsend');
  document.getElementById('custom-msg-num').value=num;
  document.getElementById('custom-msg-text').focus();
}

async function quickSetLimit(num){
  const val=prompt('عدد الرسائل اليومية للمستخدم '+num+':');
  if(val===null)return;
  const limit=parseInt(val,10);
  if(isNaN(limit)||limit<0){toast('رقم غير صحيح','#f59e0b');return;}
  const r=await api('setUserLimit',{num,limit});
  if(r.ok){toast('✅ تم وتم إشعار المستخدم');loadData();}
  else toast(r.msg||'فشل','#dc2626');
}
async function resetUserLimitNum(num){
  if(!confirm('إعادة حد '+num+' للافتراضي؟'))return;
  const r=await api('resetUserLimit',{num});
  if(r.ok){toast('تم الإعادة للافتراضي');loadData();}
  else toast(r.msg||'فشل','#dc2626');
}

// ══════════════════════════════════════════
// CONVERSATIONS — تبويب المحادثات
// ══════════════════════════════════════════
let _convUsers = [];        // قائمة المستخدمين
let _convActive = null;     // المستخدم المحدد حالياً
let _convMessages = [];     // رسائل المستخدم المحدد

async function loadConversations() {
    const list = document.getElementById('conv-user-list');
    list.innerHTML = '<div class="conv-empty">جاري التحميل...</div>';
    try {
        const r = await fetch('/conversations');
        const d = await r.json();
        if (!d.ok) { list.innerHTML = '<div class="conv-empty">فشل التحميل</div>'; return; }
        _convUsers = d.users || [];
        renderConvUserList(_convUsers);
    } catch(e) {
        list.innerHTML = '<div class="conv-empty">خطأ في الاتصال</div>';
    }
}

function renderConvUserList(users) {
    const list = document.getElementById('conv-user-list');
    if (!users.length) {
        list.innerHTML = '<div class="conv-empty">لا توجد محادثات محفوظة بعد</div>';
        return;
    }
    list.innerHTML = users.map(u => {
        const active = _convActive === u.sender ? 'active' : '';
        const vipBadge = u.isVIP ? '<span class="conv-badge-vip">VIP</span>' : '';
        const blBadge  = u.isBlocked ? '<span class="conv-badge-blocked">محظور</span>' : '';
        const lastTime = u.lastTs ? new Date(u.lastTs).toLocaleString('ar-SA',{timeZone:'Asia/Jerusalem',hour:'2-digit',minute:'2-digit',month:'short',day:'numeric'}) : '';
        return `<div class="conv-user-item ${active}" onclick="openConvChat('${esc(u.sender)}')">
          <div class="conv-user-name">
            ${esc(u.name)} ${vipBadge}${blBadge}
            <span class="conv-user-count">${u.msgCount} رسالة</span>
          </div>
          <div class="conv-user-last">${esc(u.lastMsg || '—')}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:3px">${lastTime}</div>
        </div>`;
    }).join('');
}

function filterConvUsers(q) {
    const filtered = _convUsers.filter(u =>
        u.name.includes(q) || u.sender.includes(q) || u.lastMsg.includes(q)
    );
    renderConvUserList(filtered);
}

async function openConvChat(sender) {
    _convActive = sender;
    // تمييز المستخدم المحدد
    document.querySelectorAll('.conv-user-item').forEach(el => el.classList.remove('active'));
    event?.currentTarget?.classList.add('active');

    const messages = document.getElementById('conv-messages');
    const header   = document.getElementById('conv-header');
    messages.innerHTML = '<div class="conv-empty-main"><div>⏳</div><div>جاري تحميل المحادثة...</div></div>';
    header.style.display = 'flex';

    try {
        const r = await fetch(`/conversations/${encodeURIComponent(sender)}`);
        const d = await r.json();
        if (!d.ok) { messages.innerHTML = '<div class="conv-empty-main"><div>❌</div><div>فشل التحميل</div></div>'; return; }

        _convMessages = d.messages || [];

        // تحديث الهيدر
        document.getElementById('conv-name').textContent = d.name || sender;
        document.getElementById('conv-meta').textContent =
            `${sender} • ${_convMessages.length} رسالة${d.isVIP ? ' • ⭐ VIP' : ''}`;

        renderConvMessages(_convMessages);
    } catch(e) {
        messages.innerHTML = '<div class="conv-empty-main"><div>❌</div><div>خطأ في الاتصال</div></div>';
    }
}

function renderConvMessages(msgs) {
    const container = document.getElementById('conv-messages');
    if (!msgs.length) {
        container.innerHTML = '<div class="conv-empty-main"><div>💬</div><div>لا توجد رسائل</div></div>';
        return;
    }

    let html = '';
    let lastDay = '';

    for (const msg of msgs) {
        const isUser = msg.role === 'user';
        const d = new Date(msg.ts);
        const dayStr = d.toLocaleDateString('ar-SA', { timeZone:'Asia/Jerusalem', weekday:'long', day:'numeric', month:'long' });
        const timeStr = d.toLocaleTimeString('ar-SA', { timeZone:'Asia/Jerusalem', hour:'2-digit', minute:'2-digit' });

        // فاصل اليوم
        if (dayStr !== lastDay) {
            html += `<div class="conv-day-sep">── ${dayStr} ──</div>`;
            lastDay = dayStr;
        }

        const typeIcon = msg.type === 'image' ? '🖼️' : msg.type === 'audio' ? '🎙️' : msg.type === 'pdf' ? '📄' : msg.type === 'translation' ? '🌐' : '';
        const wrapClass = isUser ? 'user' : 'bot';
        const msgClass  = isUser ? 'user' : 'bot';
        const label     = isUser ? '👤 المستخدم' : '🤖 البوت';

        html += `<div class="conv-msg-wrap ${wrapClass}">
          <div class="conv-msg ${msgClass}">${typeIcon ? typeIcon + ' ' : ''}${esc(msg.content)}</div>
          <div class="conv-msg-time">${label} • ${timeStr}</div>
        </div>`;
    }

    container.innerHTML = html;
    // تمرير للأسفل تلقائياً
    container.scrollTop = container.scrollHeight;
}

async function refreshConvChat() {
    if (_convActive) await openConvChat(_convActive);
}

async function clearConvChat() {
    if (!_convActive) return;
    if (!confirm('هل تريد مسح كل محادثات هذا المستخدم؟')) return;
    const r = await api('clearChat', { num:_convActive });
    if (r.ok) {
        toast('✅ تم مسح المحادثات');
        _convMessages = [];
        renderConvMessages([]);
        await loadConversations();
    } else {
        toast(r.msg || 'فشل المسح', '#dc2626');
    }
}

loadData();
setInterval(loadData,30000);

// فحص دور المستخدم وإخفاء العناصر غير المسموحة
(async function checkRole(){
  try {
    const r = await fetch('/session-info', {credentials:'include'});
    const info = await r.json();
    if (info.role !== 'dev') {
      // إخفاء تبويب المحادثات للـ admin العادي
      const navConv = document.querySelector('[data-tab="conversations"]');
      if (navConv) navConv.style.display = 'none';
      const panelConv = document.getElementById('panel-conversations');
      if (panelConv) panelConv.style.display = 'none';
    }
  } catch(e) {}
})();