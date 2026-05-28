/**
 * لوحة تحكم الأدمن - نادر بوت
 * تشغيل: يتم تلقائياً مع البوت
 * الرابط: http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_FILE = './bot_data.json';
const ADMIN_NUMBER = '972593850520';
const PORT = process.env.DASHBOARD_PORT || 3001;

// ===== بيانات حية (مشتركة مع البوت عبر الملف) =====
function getData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        }
    } catch (e) {}
    return { userNames: {}, welcomedUsers: {}, vipNumbers: [], reports: [], stats: {} };
}

function saveDataFromDashboard(data) {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        return false;
    }
}

// ===== HTML Dashboard =====
function renderDashboard() {
    const d = getData();
    const userCount = Object.keys(d.welcomedUsers || {}).length;
    const vipCount = (d.vipNumbers || []).length;
    const reportsCount = (d.reports || []).length;
    const stats = d.stats || {};

    const vipRows = (d.vipNumbers || []).map(num => {
        const name = (d.userNames || {})[num] || '—';
        return `<tr>
            <td>${num}</td>
            <td>${name}</td>
            <td><button class="btn-danger" onclick="removeVip('${num}')">حذف</button></td>
        </tr>`;
    }).join('') || '<tr><td colspan="3" class="empty">لا يوجد أرقام VIP</td></tr>';

    const reportRows = (d.reports || []).slice(-50).reverse().map((r, i) => `<tr>
        <td>${i + 1}</td>
        <td>${r.name || '—'}</td>
        <td dir="ltr">${r.sender}</td>
        <td>${r.text}</td>
        <td>${r.time}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">لا يوجد بلاغات</td></tr>';

    const userRows = Object.entries(d.userNames || {}).slice(-100).reverse().map(([num, name]) => `<tr>
        <td dir="ltr">${num}</td>
        <td>${name}</td>
        <td>${(d.vipNumbers || []).includes(num) ? '⭐ VIP' : '—'}</td>
        <td>
            ${!(d.vipNumbers || []).includes(num)
                ? `<button class="btn-success" onclick="addVip('${num}')">+ VIP</button>`
                : `<button class="btn-danger" onclick="removeVip('${num}')">حذف VIP</button>`
            }
        </td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty">لا يوجد مستخدمين</td></tr>';

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>نادر بوت - لوحة التحكم</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }

  .topbar { background: linear-gradient(135deg, #1e293b, #0f172a); border-bottom: 1px solid #334155; padding: 16px 28px; display: flex; align-items: center; justify-content: space-between; }
  .topbar h1 { font-size: 22px; color: #38bdf8; }
  .topbar span { font-size: 13px; color: #64748b; }
  .status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; margin-left: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 28px; }
  .stat-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; text-align: center; transition: transform .2s; }
  .stat-card:hover { transform: translateY(-2px); }
  .stat-card .num { font-size: 36px; font-weight: 700; color: #38bdf8; }
  .stat-card .label { font-size: 13px; color: #94a3b8; margin-top: 4px; }
  .stat-card.green .num { color: #22c55e; }
  .stat-card.yellow .num { color: #f59e0b; }
  .stat-card.red .num { color: #f87171; }
  .stat-card.purple .num { color: #a78bfa; }

  .tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  .tab { padding: 8px 18px; border-radius: 8px; cursor: pointer; font-size: 14px; border: 1px solid #334155; background: #1e293b; color: #94a3b8; transition: all .2s; }
  .tab.active { background: #38bdf8; color: #0f172a; border-color: #38bdf8; font-weight: 600; }

  .panel { display: none; }
  .panel.active { display: block; }

  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; overflow: hidden; margin-bottom: 20px; }
  .card-header { padding: 14px 20px; background: #0f172a; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between; }
  .card-header h3 { font-size: 15px; color: #e2e8f0; }

  table { width: 100%; border-collapse: collapse; }
  th { padding: 10px 14px; text-align: right; font-size: 12px; color: #64748b; background: #0f172a; border-bottom: 1px solid #334155; }
  td { padding: 11px 14px; font-size: 13px; border-bottom: 1px solid #1e293b; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(56,189,248,.04); }
  .empty { text-align: center; color: #475569; padding: 24px; }

  .btn-danger { background: #dc2626; color: white; border: none; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .btn-success { background: #16a34a; color: white; border: none; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .btn-primary { background: #38bdf8; color: #0f172a; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; }

  .add-vip-form { display: flex; gap: 10px; padding: 16px 20px; background: #0f172a; border-top: 1px solid #334155; }
  .add-vip-form input { flex: 1; background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 8px 12px; border-radius: 8px; font-size: 13px; }
  .add-vip-form input:focus { outline: none; border-color: #38bdf8; }

  .refresh-btn { background: transparent; border: 1px solid #334155; color: #94a3b8; padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 12px; }
  .refresh-btn:hover { border-color: #38bdf8; color: #38bdf8; }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; }
  .badge-red { background: rgba(239,68,68,.15); color: #f87171; }
  .badge-blue { background: rgba(56,189,248,.15); color: #38bdf8; }

  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #22c55e; color: white; padding: 10px 24px; border-radius: 10px; font-size: 14px; opacity: 0; transition: opacity .3s; pointer-events: none; z-index: 999; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<div class="topbar">
  <h1>🤖 نادر بوت <span class="status-dot"></span></h1>
  <span>لوحة التحكم | آخر تحديث: ${new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Jerusalem' })}</span>
</div>

<div class="container">
  <!-- Stats -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="num">${userCount}</div>
      <div class="label">👥 إجمالي المستخدمين</div>
    </div>
    <div class="stat-card green">
      <div class="num">${vipCount}</div>
      <div class="label">⭐ أرقام VIP</div>
    </div>
    <div class="stat-card yellow">
      <div class="num">${stats.totalMessages || 0}</div>
      <div class="label">💬 رسائل نصية</div>
    </div>
    <div class="stat-card purple">
      <div class="num">${stats.totalImages || 0}</div>
      <div class="label">🖼️ صور محللة</div>
    </div>
    <div class="stat-card">
      <div class="num">${stats.totalMedical || 0}</div>
      <div class="label">🏥 صور طبية</div>
    </div>
    <div class="stat-card">
      <div class="num">${stats.totalDocs || 0}</div>
      <div class="label">📄 ملفات</div>
    </div>
    <div class="stat-card red">
      <div class="num">${reportsCount}</div>
      <div class="label">🚨 بلاغات</div>
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <div class="tab active" onclick="showTab('users')">👥 المستخدمون</div>
    <div class="tab" onclick="showTab('vip')">⭐ VIP</div>
    <div class="tab" onclick="showTab('reports')">🚨 البلاغات <span class="badge badge-red">${reportsCount}</span></div>
  </div>

  <!-- Users Panel -->
  <div class="panel active" id="panel-users">
    <div class="card">
      <div class="card-header">
        <h3>قائمة المستخدمين (آخر 100)</h3>
        <button class="refresh-btn" onclick="location.reload()">🔄 تحديث</button>
      </div>
      <table>
        <thead><tr><th>الرقم</th><th>الاسم</th><th>النوع</th><th>إجراء</th></tr></thead>
        <tbody>${userRows}</tbody>
      </table>
    </div>
  </div>

  <!-- VIP Panel -->
  <div class="panel" id="panel-vip">
    <div class="card">
      <div class="card-header">
        <h3>⭐ أرقام VIP</h3>
      </div>
      <table>
        <thead><tr><th>الرقم</th><th>الاسم</th><th>إجراء</th></tr></thead>
        <tbody>${vipRows}</tbody>
      </table>
      <div class="add-vip-form">
        <input id="newVipNum" type="text" placeholder="أدخل رقم الهاتف (مع كود البلد)" dir="ltr">
        <button class="btn-primary" onclick="addVipFromInput()">+ إضافة VIP</button>
      </div>
    </div>
  </div>

  <!-- Reports Panel -->
  <div class="panel" id="panel-reports">
    <div class="card">
      <div class="card-header">
        <h3>🚨 البلاغات الأخيرة (50 بلاغ)</h3>
        <button class="btn-danger" onclick="clearReports()" style="font-size:12px;padding:5px 12px;">مسح الكل</button>
      </div>
      <table>
        <thead><tr><th>#</th><th>الاسم</th><th>الرقم</th><th>المشكلة</th><th>الوقت</th></tr></thead>
        <tbody>${reportRows}</tbody>
      </table>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
function showTab(name) {
    document.querySelectorAll('.tab').forEach((t,i) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const tabs = document.querySelectorAll('.tab');
    const idx = ['users','vip','reports'].indexOf(name);
    if (idx >= 0) tabs[idx].classList.add('active');
    document.getElementById('panel-' + name).classList.add('active');
}

function toast(msg, color) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.background = color || '#22c55e';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

async function apiCall(action, body) {
    try {
        const res = await fetch('/api', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...body })
        });
        const data = await res.json();
        return data;
    } catch (e) {
        toast('خطأ في الاتصال', '#dc2626');
    }
}

async function addVip(num) {
    const r = await apiCall('addVip', { num });
    if (r.ok) { toast('✅ تم إضافة VIP'); setTimeout(() => location.reload(), 800); }
    else toast('فشل', '#dc2626');
}

async function removeVip(num) {
    if (!confirm('هل تريد حذف هذا الرقم من VIP؟')) return;
    const r = await apiCall('removeVip', { num });
    if (r.ok) { toast('🗑️ تم الحذف'); setTimeout(() => location.reload(), 800); }
    else toast('فشل', '#dc2626');
}

function addVipFromInput() {
    const num = document.getElementById('newVipNum').value.trim();
    if (!num) return toast('أدخل رقماً', '#f59e0b');
    addVip(num);
}

async function clearReports() {
    if (!confirm('هل تريد مسح كل البلاغات؟')) return;
    const r = await apiCall('clearReports', {});
    if (r.ok) { toast('✅ تم مسح البلاغات'); setTimeout(() => location.reload(), 800); }
}
</script>
</body>
</html>`;
}

// ===== HTTP SERVER =====
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
            try {
                const { action, num } = JSON.parse(body);
                const d = getData();

                if (action === 'addVip') {
                    if (num && !d.vipNumbers.includes(num)) {
                        d.vipNumbers.push(num);
                        saveDataFromDashboard(d);
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } else if (action === 'removeVip') {
                    d.vipNumbers = d.vipNumbers.filter(n => n !== num);
                    saveDataFromDashboard(d);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } else if (action === 'clearReports') {
                    d.reports = [];
                    saveDataFromDashboard(d);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } else {
                    res.writeHead(400); res.end('{}');
                }
            } catch (e) {
                res.writeHead(500); res.end('{}');
            }
        });
        return;
    }

    if (req.method === 'GET' && req.url === '/') {
        const html = renderDashboard();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
    }

    res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`📊 لوحة التحكم تعمل على: http://localhost:${PORT}`);
});

module.exports = server;
