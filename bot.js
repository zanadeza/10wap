'use strict';

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const QRCode = require('qrcode-terminal');
const QRCodeImg = require('qrcode');
const http = require('http');
const fs   = require('fs');

// ============================================================
// CONFIG
// ============================================================
const MISTRAL_API_KEY = 'fZ0TSrAOJK3cBjkmj461Msqhk90d0HiL';
const ADMIN_NUMBER    = '972593850520';   // بدون + أو @
const BOT_NAME        = 'MedTerm';
const DATA_FILE       = './bot_data.json';
const WEB_PORT        = 3000;

let currentQR = null;
let isConnected = false;
const MAX_HISTORY     = 30;              // أقصى رسائل في السياق
const API_TIMEOUT_MS  = 30_000;         // 30 ثانية timeout للـ API

// ============================================================
// PERSISTENCE
// ============================================================
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE))
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch (_) {}
    return {
        userNames:      {},
        welcomedUsers:  {},
        vipNumbers:     [],
        reports:        [],
        stats:          { totalMessages: 0, totalImages: 0, totalMedical: 0 }
    };
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(
            { userNames, welcomedUsers, vipNumbers, reports, stats },
            null, 2
        ));
    } catch (e) {
        console.error('[saveData] خطأ:', e.message);
    }
}

let { userNames, welcomedUsers, vipNumbers, reports, stats } = loadData();

// ضمان وجود الحقول
if (!Array.isArray(reports))   reports = [];
if (!stats)                    stats   = { totalMessages: 0, totalImages: 0, totalMedical: 0 };
if (!stats.totalMessages)      stats.totalMessages = 0;
if (!stats.totalImages)        stats.totalImages   = 0;
if (!stats.totalMedical)       stats.totalMedical  = 0;

// إضافة الأدمن للمستخدمين المرحّب بهم تلقائياً حتى لا يستقبل رسالة ترحيب
welcomedUsers[ADMIN_NUMBER] = true;
saveData();

let userChats       = {};   // سياق المحادثة (RAM فقط)
let sock            = null;
let schedulersStarted = false;  // منع تشغيل المجدولات أكثر من مرة

// ============================================================
// SYSTEM PROMPTS
// ============================================================
const SYSTEM_PROMPT = `اسمك "${BOT_NAME}"، بوت ذكاء اصطناعي متخصص على واتساب.

شخصيتك:
- جدية ومهنية بنسبة 95٪، ردودك دقيقة ومباشرة بدون حشو
- اللغة الافتراضية عربية واضحة وسهلة، وإذا طلب المستخدم لغة أخرى تحدّث بها
- أعطِ المعلومة الصحيحة الكاملة في أول مرة
- إذا لم تعرف شيئاً قل: "لا تتوفر لديّ معلومات كافية حول هذا الموضوع"
- لا تستخدم جداول، اكتب كل شيء كنص عادي منظّم
- لا تستخدم مصطلحات أجنبية غير ضرورية، عربي وإنجليزي فقط عند الحاجة
- اقرأ سياق المحادثة كاملاً وربط الرسائل ببعضها قبل الرد
- إذا سُئلت عن اسمك قل: "أنا ${BOT_NAME}، بوت ذكاء اصطناعي"
- تتعامل مع جميع أرقام دول العالم باحترام

المجال الطبي والعلمي:
- معلومات دقيقة 100٪ موثوقة
- اذكر الجرعات والأدوية بدقة عند الحاجة
- نبّه دائماً بمراجعة الطبيب للحالات الخطيرة أو المزمنة
- في تحليل الصور الطبية: كن متخصصاً ودقيقاً واطلب مراجعة متخصص للتأكيد

اسم المستخدم موجود في السياق، استخدمه أحياناً بشكل طبيعي.`;

const MEDICAL_IMAGE_PROMPT = `أنت طبيب متخصص ومحلل صور طبية خبير. حلّل الصورة الطبية بدقة عالية.

اتبع هذا الترتيب في ردك:
1. نوع الصورة: أشعة X أو CT أو MRI أو تحليل دم أو تقرير مخبري
2. الملاحظات الرئيسية: ما تلاحظه بوضوح
3. التفسير الطبي: ماذا تعني هذه الملاحظات
4. الحالة: هل القيم ضمن المعدل الطبيعي أم لا، وضّح بوضوح
5. التوصية: الخطوة التالية المقترحة

قواعد:
- كن دقيقاً ومهنياً
- اذكر أي نتيجة غير طبيعية بوضوح
- لا تستخدم جداول، اكتب كل شيء كنص عادي
- اختم دائماً بـ: "تنبيه: هذا التحليل للمعلومة فقط، يجب مراجعة طبيب متخصص للتشخيص النهائي"`;

// ============================================================
// HELPERS
// ============================================================

// استخراج الرقم النظيف من JID
function cleanNumber(jidOrNumber) {
    return (jidOrNumber || '')
        .replace('@s.whatsapp.net', '')
        .replace('@lid', '')
        .replace('@g.us', '')
        .replace('+', '')
        .trim();
}

// توقيت القدس
function nowJerusalem() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
}

// API call مع timeout
async function fetchWithTimeout(url, options, timeoutMs = API_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

// ============================================================
// AI FUNCTIONS
// ============================================================
async function askAI(messages) {
    try {
        const response = await fetchWithTimeout(
            'https://api.mistral.ai/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'mistral-small-latest',
                    messages,
                    max_tokens: 1200,
                    temperature: 0.5
                })
            }
        );

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data?.choices?.[0]?.message?.content) throw new Error('استجابة فارغة من API');
        return data.choices[0].message.content;

    } catch (e) {
        console.error('[askAI]', e.message);
        if (e.name === 'AbortError') return 'انتهت مهلة الاستجابة، يرجى المحاولة مرة أخرى.';
        return 'عذراً، حدث خطأ تقني. يرجى المحاولة مرة أخرى.';
    }
}

function isMedicalImage(text) {
    return /أشعة|xray|x-ray|mri|رنين|ct scan|تحليل دم|فحص دم|صورة طبية|تقرير طبي|مختبر|مخبر|lab|blood test|صورة صدر|قلب|كلية|كبد|دماغ|brain|lung|kidney|liver|heart|ultrasound|سونار|إيكو|echo|ecg|ekg|نتائج|results|تقرير|فحص/i
        .test(text || '');
}

async function askAIWithImage(base64Image, userQuestion, userName) {
    try {
        const isMedical   = isMedicalImage(userQuestion);
        const systemToUse = isMedical ? MEDICAL_IMAGE_PROMPT : SYSTEM_PROMPT;
        const questionText = userQuestion ||
            (isMedical ? 'حلل هذه الصورة الطبية بالتفصيل' : 'صف ما تراه في هذه الصورة بالتفصيل');

        const response = await fetchWithTimeout(
            'https://api.mistral.ai/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'pixtral-large-latest',
                    messages: [
                        { role: 'system', content: systemToUse },
                        {
                            role: 'user',
                            content: [
                                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
                                { type: 'text', text: userName ? `اسم المستخدم: ${userName}\n${questionText}` : questionText }
                            ]
                        }
                    ],
                    max_tokens: isMedical ? 2000 : 1500,
                    temperature: isMedical ? 0.3 : 0.5
                })
            }
        );

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data?.choices?.[0]?.message?.content) throw new Error('استجابة فارغة');
        return data.choices[0].message.content;

    } catch (e) {
        console.error('[askAIWithImage]', e.message);
        if (e.name === 'AbortError') return 'انتهت مهلة التحليل، يرجى المحاولة مرة أخرى.';
        return 'عذراً، لم أتمكن من تحليل الصورة. يرجى المحاولة مرة أخرى.';
    }
}

// ============================================================
// BROADCAST
// ============================================================
// كل مستخدم رسالة عشوائية مختلفة + rate limiting ذكي
async function broadcastToAll(getTextFn) {
    const allUsers = Object.keys(welcomedUsers).filter(n => n !== ADMIN_NUMBER);
    let sent = 0, failed = 0;

    for (let i = 0; i < allUsers.length; i++) {
        const num = allUsers[i];

        // كل 20 رسالة استراحة 5 دقائق
        if (i > 0 && i % 20 === 0) {
            console.log(`⏸️ استراحة 5 دقائق بعد ${i} رسائل...`);
            await new Promise(r => setTimeout(r, 5 * 60_000));
        }

        try {
            // لو دالة: رسالة مختلفة لكل مستخدم، لو نص: نفس الرسالة
            const text = typeof getTextFn === 'function' ? getTextFn() : getTextFn;
            await sock.sendMessage(`${num}@s.whatsapp.net`, { text });
            sent++;
        } catch {
            failed++;
        }

        // 5 ثواني بين كل رسالة ورسالة
        await new Promise(r => setTimeout(r, 5000));
    }

    return { sent, failed, total: allUsers.length };
}

// ============================================================
// PRAYER & DHIKR
// ============================================================
const PRAYER_SCHEDULE = [
    { name: 'الفجر',  hour: 4,  minute: 30 },
    { name: 'الظهر',  hour: 12, minute: 15 },
    { name: 'العصر',  hour: 15, minute: 30 },
    { name: 'المغرب', hour: 18, minute: 15 },
    { name: 'العشاء', hour: 20, minute: 0  }
];

const DHIKR_LIST = [
    'سبحان الله وبحمده، سبحان الله العظيم\n\nاللهم أعنّا على ذكرك وشكرك وحسن عبادتك',
    'أستغفر الله العظيم الذي لا إله إلا هو الحي القيوم وأتوب إليه\n\nاستغفروا ربكم إنه كان غفاراً',
    'لا إله إلا الله وحده لا شريك له، له الملك وله الحمد وهو على كل شيء قدير\n\nأكثروا من هذا الذكر في صباحكم ومسائكم',
    'سبحان الله والحمد لله ولا إله إلا الله والله أكبر\n\nهذه الكلمات أحب إلى الله من كل ما طلعت عليه الشمس',
    'رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً وَفِي الآخِرَةِ حَسَنَةً وَقِنَا عَذَابَ النَّارِ\n\nاللهم آمين',
    'اللهم إني أسألك العفو والعافية في الدنيا والآخرة\n\nاللهم آمين يا رب العالمين',
    'حسبي الله ونعم الوكيل، نعم المولى ونعم النصير\n\nمن قالها سبعاً كفاه الله ما أهمه',
    'اللهم إنك عفو تحب العفو فاعفُ عنا\n\nأكثر من هذا الدعاء في ليالي القدر وفي كل وقت',
    'بسم الله الرحمن الرحيم\nقل هو الله أحد، الله الصمد، لم يلد ولم يولد، ولم يكن له كفواً أحد\n\nمن قرأها ثلاثاً فكأنما قرأ القرآن كاملاً',
    'لا حول ولا قوة إلا بالله العلي العظيم\n\nهي كنز من كنوز الجنة، أكثر منها في يومك',
    'اللهم صل على محمد وأزواجه وذريته كما صليت على آل إبراهيم\nوبارك على محمد وأزواجه وذريته كما باركت على آل إبراهيم إنك حميد مجيد',
    'سبحان الله وبحمده، عدد خلقه، ورضا نفسه، وزنة عرشه، ومداد كلماته\n\nقلها ثلاثاً في الصباح تعدل ساعات من الذكر'
];

const SALAH_LIST = [
    'اللهم صلِّ على محمد وعلى آل محمد\nكما صليت على إبراهيم وعلى آل إبراهيم\nإنك حميد مجيد',
    'اللهم صلِّ وسلِّم وبارك على نبينا محمد\nمن صلّى عليّ مرة صلى الله عليه بها عشراً',
    'اللهم صلِّ على محمد النبي الأمي وعلى آله وصحبه وسلِّم\nأكثروا من الصلاة على النبي يوم الجمعة',
    'اللهم صلِّ على محمد وعلى آله وصحبه أجمعين\nمن أكثر من الصلاة عليّ كنت له شفيعاً يوم القيامة',
    'صلى الله على النبي الكريم وآله الطيبين الطاهرين\nوسلّم تسليماً كثيراً إلى يوم الدين',
    'اللهم صلِّ وسلِّم على عبدك ورسولك محمد\nوعلى آله وأصحابه ومن تبعهم بإحسان'
];

// اختيار عشوائي مع تجنب التكرار
const _lastPicked = {};
function rand(arr, key) {
    if (!key) return arr[Math.floor(Math.random() * arr.length)];
    let idx;
    do { idx = Math.floor(Math.random() * arr.length); }
    while (arr.length > 1 && idx === _lastPicked[key]);
    _lastPicked[key] = idx;
    return arr[idx];
}

function startSchedulers() {
    if (schedulersStarted) return;
    schedulersStarted = true;
    console.log('⏰ تشغيل المجدولات...');

    // فحص أوقات الصلاة كل دقيقة (بتوقيت القدس)
    setInterval(async () => {
        if (!sock) return;
        const now    = nowJerusalem();
        const hour   = now.getHours();
        const minute = now.getMinutes();

        for (const prayer of PRAYER_SCHEDULE) {
            if (prayer.hour === hour && prayer.minute === minute) {
                const pName = prayer.name;
                await broadcastToAll(() => {
                    const extras = [
                        'اللهم اجعلنا من المحافظين على الصلوات',
                        'الصلاة نور، حافظ عليها',
                        'قم إلى الصلاة رحمك الله',
                        'الصلاة خير من النوم'
                    ];
                    return `🕌 *حان وقت صلاة ${pName}*\n\n${rand(extras)}\nحي على الصلاة، حي على الفلاح`;
                }).catch(console.error);
                console.log(`🕌 تم إرسال تنبيه صلاة ${prayer.name}`);
            }
        }
    }, 60_000);

    // ذكر واستغفار كل 6 ساعات — كل مستخدم رسالة مختلفة
    setInterval(async () => {
        if (!sock) return;
        console.log('📿 بدء إرسال الذكر...');
        await broadcastToAll(() => `📿 *ذكر*\n\n${rand(DHIKR_LIST, 'dhikr')}`).catch(console.error);
        console.log('📿 تم إرسال الذكر');
    }, 6 * 60 * 60_000);

    // صلاة على النبي مرة يومياً — كل مستخدم رسالة مختلفة
    setInterval(async () => {
        if (!sock) return;
        console.log('💚 بدء إرسال الصلاة على النبي...');
        await broadcastToAll(() => `💚 *صلاة على النبي ﷺ*\n\n${rand(SALAH_LIST, 'salah')}`).catch(console.error);
        console.log('💚 تم إرسال الصلاة على النبي');
    }, 24 * 60 * 60_000);
}


// ============================================================
// QR WEB SERVER
// ============================================================
function startQRServer() {
    const server = http.createServer(async (req, res) => {
        const url = req.url.split('?')[0];

        // ===== QR IMAGE =====
        if (url === '/qr-image' && currentQR) {
            try {
                const buf = await QRCodeImg.toBuffer(currentQR, { errorCorrectionLevel: 'H', width: 400, margin: 2 });
                res.writeHead(200, { 'Content-Type': 'image/png' });
                res.end(buf);
            } catch { res.writeHead(500); res.end(); }
            return;
        }

        // ===== API =====
        if (url === '/api' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { action, data } = JSON.parse(body);
                    let result = { ok: true };

                    if (action === 'addVip') {
                        const num = (data.num || '').replace(/\D/g, '');
                        if (num && !vipNumbers.includes(num)) { vipNumbers.push(num); saveData(); }
                    }
                    else if (action === 'removeVip') {
                        vipNumbers = vipNumbers.filter(n => n !== data.num);
                        saveData();
                    }
                    else if (action === 'deleteUser') {
                        const num = data.num;
                        delete userChats[num];
                        delete welcomedUsers[num];
                        delete userNames[num];
                        saveData();
                    }
                    else if (action === 'clearReports') {
                        reports = [];
                        saveData();
                    }
                    else if (action === 'clearSessions') {
                        userChats = {};
                        result.msg = 'تم مسح الجلسات';
                    }
                    else if (action === 'broadcast') {
                        if (!isConnected) { result = { ok: false, msg: 'البوت غير متصل' }; }
                        else {
                            const txt = data.text || '';
                            if (!txt) { result = { ok: false, msg: 'الرسالة فارغة' }; }
                            else {
                                broadcastToAll(`📢 *رسالة من الإدارة*\n\n${txt}`).then(r => {
                                    console.log(`📢 بث: ${r.sent} نجح، ${r.failed} فشل`);
                                }).catch(console.error);
                                result.msg = 'بدأ الإرسال في الخلفية';
                            }
                        }
                    }
                    else if (action === 'stats') {
                        result.data = {
                            connected: isConnected,
                            users: Object.keys(welcomedUsers).length,
                            active: Object.keys(userChats).length,
                            vip: vipNumbers.length,
                            reports: reports.length,
                            stats
                        };
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, msg: e.message }));
                }
            });
            return;
        }

        // ===== DATA API =====
        if (url === '/data') {
            const d = {
                connected: isConnected,
                hasQR: !!currentQR,
                botName: BOT_NAME,
                stats: {
                    users: Object.keys(welcomedUsers).length,
                    active: Object.keys(userChats).length,
                    vip: vipNumbers.length,
                    messages: stats.totalMessages || 0,
                    images: stats.totalImages || 0,
                    medical: stats.totalMedical || 0,
                    reports: reports.length
                },
                vipNumbers,
                userNames,
                welcomedUsers: Object.keys(welcomedUsers),
                reports: reports.slice(-50).reverse()
            };
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(d));
            return;
        }

        // ===== MAIN DASHBOARD =====
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${BOT_NAME} - لوحة التحكم</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.topbar{background:linear-gradient(135deg,#1e293b,#0f172a);border-bottom:1px solid #334155;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.topbar h1{font-size:18px;color:#38bdf8;display:flex;align-items:center;gap:8px}
.dot{width:10px;height:10px;border-radius:50%;background:#64748b;display:inline-block;transition:.3s}
.dot.on{background:#22c55e;box-shadow:0 0 8px #22c55e;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.container{max-width:1100px;margin:0 auto;padding:20px}
.tabs{display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap}
.tab{padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;border:1px solid #334155;background:#1e293b;color:#94a3b8;transition:.2s}
.tab.active{background:#38bdf8;color:#0f172a;border-color:#38bdf8;font-weight:700}
.panel{display:none}.panel.active{display:block}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.sc{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px;text-align:center}
.sc .n{font-size:32px;font-weight:700;color:#38bdf8}
.sc.g .n{color:#22c55e}.sc.y .n{color:#f59e0b}.sc.r .n{color:#f87171}.sc.p .n{color:#a78bfa}
.sc .l{font-size:12px;color:#64748b;margin-top:4px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden;margin-bottom:16px}
.ch{padding:14px 18px;background:#0f172a;border-bottom:1px solid #334155;display:flex;align-items:center;justify-content:space-between}
.ch h3{font-size:14px;color:#e2e8f0}
table{width:100%;border-collapse:collapse}
th{padding:10px 14px;text-align:right;font-size:12px;color:#64748b;background:#0f172a;border-bottom:1px solid #334155}
td{padding:10px 14px;font-size:13px;border-bottom:1px solid #0f172a}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(56,189,248,.04)}
.empty{text-align:center;color:#475569;padding:24px;font-size:13px}
.btn{border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600}
.btn-r{background:#dc2626;color:#fff}
.btn-g{background:#16a34a;color:#fff}
.btn-b{background:#38bdf8;color:#0f172a}
.btn-y{background:#f59e0b;color:#0f172a}
.inp{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:8px 12px;border-radius:8px;font-size:13px;width:100%}
.inp:focus{outline:none;border-color:#38bdf8}
.form-row{display:flex;gap:8px;padding:14px 18px;background:#0f172a;border-top:1px solid #334155}
textarea.inp{resize:vertical;min-height:80px}
.badge{padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700}
.badge-g{background:rgba(34,197,94,.15);color:#22c55e}
.badge-r{background:rgba(248,113,113,.15);color:#f87171}
.badge-b{background:rgba(56,189,248,.15);color:#38bdf8}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:10px 24px;border-radius:10px;font-size:13px;opacity:0;transition:.3s;pointer-events:none;z-index:999;font-weight:600}
.toast.show{opacity:1}
.qr-wrap{display:flex;align-items:center;justify-content:center;padding:30px;flex-direction:column;gap:16px}
.qr-wrap img{border-radius:12px;width:260px;height:260px}
.qr-steps{background:#0f172a;border-radius:12px;padding:16px;text-align:right;font-size:13px;color:#94a3b8;line-height:2}
.qr-steps span{color:#38bdf8;font-weight:700}
.connected-badge{background:rgba(34,197,94,.15);color:#22c55e;padding:12px 24px;border-radius:12px;font-size:16px;font-weight:700}
</style>
</head>
<body>
<div class="topbar">
  <h1>🤖 ${BOT_NAME} <span class="dot" id="dot"></span></h1>
  <span id="connLabel" style="font-size:12px;color:#64748b">جاري التحقق...</span>
</div>
<div class="container">
  <div class="tabs">
    <div class="tab active" onclick="showTab('overview')">📊 نظرة عامة</div>
    <div class="tab" onclick="showTab('qr')">📱 ربط واتساب</div>
    <div class="tab" onclick="showTab('broadcast')">📢 البث</div>
    <div class="tab" onclick="showTab('users')">👥 المستخدمون</div>
    <div class="tab" onclick="showTab('vip')">⭐ VIP</div>
    <div class="tab" onclick="showTab('reports')">🚨 البلاغات</div>
  </div>

  <!-- نظرة عامة -->
  <div class="panel active" id="panel-overview">
    <div class="stats" id="stats-grid">
      <div class="sc"><div class="n" id="s-users">—</div><div class="l">👥 المستخدمون</div></div>
      <div class="sc g"><div class="n" id="s-active">—</div><div class="l">🟢 جلسات نشطة</div></div>
      <div class="sc y"><div class="n" id="s-vip">—</div><div class="l">⭐ VIP</div></div>
      <div class="sc"><div class="n" id="s-msgs">—</div><div class="l">💬 رسائل</div></div>
      <div class="sc p"><div class="n" id="s-imgs">—</div><div class="l">🖼️ صور</div></div>
      <div class="sc"><div class="n" id="s-med">—</div><div class="l">🏥 طبية</div></div>
      <div class="sc r"><div class="n" id="s-rep">—</div><div class="l">🚨 بلاغات</div></div>
    </div>
    <div class="card">
      <div class="ch"><h3>⚡ إجراءات سريعة</h3></div>
      <div style="padding:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-r" onclick="doAction('clearSessions')">🗑️ مسح الجلسات</button>
        <button class="btn btn-y" onclick="showTab('broadcast')">📢 إرسال بث</button>
        <button class="btn btn-b" onclick="loadData()">🔄 تحديث</button>
      </div>
    </div>
  </div>

  <!-- ربط واتساب -->
  <div class="panel" id="panel-qr">
    <div class="card">
      <div class="ch"><h3>📱 حالة الاتصال</h3></div>
      <div class="qr-wrap" id="qr-section">
        <div style="color:#64748b;font-size:14px">جاري التحميل...</div>
      </div>
    </div>
  </div>

  <!-- البث -->
  <div class="panel" id="panel-broadcast">
    <div class="card">
      <div class="ch"><h3>📢 إرسال رسالة لجميع المستخدمين</h3></div>
      <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
        <textarea class="inp" id="broadcast-text" placeholder="اكتب الرسالة هنا..."></textarea>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-b" onclick="sendBroadcast()">📢 إرسال للجميع</button>
          <span id="broadcast-count" style="font-size:12px;color:#64748b"></span>
        </div>
        <div style="background:#0f172a;border-radius:8px;padding:12px;font-size:12px;color:#64748b">
          ⚠️ الرسالة ستُرسل لجميع المستخدمين. هناك تأخير 5 ثواني بين كل رسالة.
        </div>
      </div>
    </div>
  </div>

  <!-- المستخدمون -->
  <div class="panel" id="panel-users">
    <div class="card">
      <div class="ch">
        <h3>👥 المستخدمون</h3>
        <input class="inp" style="width:200px;padding:6px 10px" id="user-search" placeholder="بحث..." oninput="filterUsers()">
      </div>
      <table>
        <thead><tr><th>الرقم</th><th>الاسم</th><th>النوع</th><th>إجراء</th></tr></thead>
        <tbody id="users-table"><tr><td colspan="4" class="empty">جاري التحميل...</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- VIP -->
  <div class="panel" id="panel-vip">
    <div class="card">
      <div class="ch"><h3>⭐ أرقام VIP</h3></div>
      <table>
        <thead><tr><th>الرقم</th><th>الاسم</th><th>إجراء</th></tr></thead>
        <tbody id="vip-table"><tr><td colspan="3" class="empty">جاري التحميل...</td></tr></tbody>
      </table>
      <div class="form-row">
        <input class="inp" id="new-vip" placeholder="أدخل رقم الهاتف مع كود الدولة" dir="ltr">
        <button class="btn btn-g" onclick="addVip()">+ إضافة</button>
      </div>
    </div>
  </div>

  <!-- البلاغات -->
  <div class="panel" id="panel-reports">
    <div class="card">
      <div class="ch">
        <h3>🚨 البلاغات</h3>
        <button class="btn btn-r" onclick="clearReports()">مسح الكل</button>
      </div>
      <table>
        <thead><tr><th>#</th><th>الاسم</th><th>الرقم</th><th>المشكلة</th><th>الوقت</th></tr></thead>
        <tbody id="reports-table"><tr><td colspan="5" class="empty">جاري التحميل...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let _data = null;

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => {
    const names = ['overview','qr','broadcast','users','vip','reports'];
    t.classList.toggle('active', names[i] === name);
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  loadData();
}

function toast(msg, color) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = color || '#22c55e';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

async function api(action, data = {}) {
  try {
    const r = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, data })
    });
    return await r.json();
  } catch (e) {
    toast('خطأ في الاتصال', '#dc2626');
    return { ok: false };
  }
}

async function loadData() {
  try {
    const r = await fetch('/data');
    _data = await r.json();
    updateUI();
  } catch (e) {
    console.error(e);
  }
}

function updateUI() {
  if (!_data) return;
  const d = _data;

  // topbar
  const dot = document.getElementById('dot');
  const lbl = document.getElementById('connLabel');
  dot.className = 'dot' + (d.connected ? ' on' : '');
  lbl.textContent = d.connected ? '✅ متصل وشغال' : '❌ غير متصل';

  // stats
  const s = d.stats;
  setText('s-users', s.users);
  setText('s-active', s.active);
  setText('s-vip', s.vip);
  setText('s-msgs', s.messages);
  setText('s-imgs', s.images);
  setText('s-med', s.medical);
  setText('s-rep', s.reports);

  // broadcast count
  const bc = document.getElementById('broadcast-count');
  if (bc) bc.textContent = 'سيصل لـ ' + (s.users - 1) + ' مستخدم';

  // QR
  const qrSec = document.getElementById('qr-section');
  if (d.connected) {
    qrSec.innerHTML = '<div class="connected-badge">✅ البوت متصل بواتساب وشغال!</div>';
  } else if (d.hasQR) {
    qrSec.innerHTML = \`
      <img src="/qr-image?t=\${Date.now()}" alt="QR">
      <div class="qr-steps">
        <div><span>1.</span> افتح واتساب على هاتفك</div>
        <div><span>2.</span> الإعدادات ← الأجهزة المرتبطة</div>
        <div><span>3.</span> اضغط "ربط جهاز"</div>
        <div><span>4.</span> امسح الكود</div>
      </div>
    \`;
  } else {
    qrSec.innerHTML = '<div style="color:#64748b;font-size:14px">⏳ في انتظار رمز QR...</div>';
  }

  // Users
  renderUsers(d);

  // VIP
  renderVip(d);

  // Reports
  renderReports(d);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}

let _allUsers = [];
function renderUsers(d) {
  _allUsers = d.welcomedUsers.map(num => ({
    num,
    name: d.userNames[num] || '—',
    isVip: d.vipNumbers.includes(num)
  }));
  filterUsers();
}

function filterUsers() {
  const q = (document.getElementById('user-search')?.value || '').toLowerCase();
  const filtered = q ? _allUsers.filter(u => u.num.includes(q) || u.name.toLowerCase().includes(q)) : _allUsers;
  const tb = document.getElementById('users-table');
  if (!filtered.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">لا يوجد مستخدمون</td></tr>'; return; }
  tb.innerHTML = filtered.slice(0,100).map(u => \`<tr>
    <td dir="ltr">\${u.num}</td>
    <td>\${u.name}</td>
    <td><span class="badge \${u.isVip ? 'badge-b' : 'badge-g'}">\${u.isVip ? '⭐ VIP' : 'عادي'}</span></td>
    <td style="display:flex;gap:6px">
      \${!u.isVip ? \`<button class="btn btn-b" onclick="addVipNum('\${u.num}')">+ VIP</button>\` : \`<button class="btn btn-y" onclick="removeVipNum('\${u.num}')">إزالة VIP</button>\`}
      <button class="btn btn-r" onclick="deleteUser('\${u.num}')">حذف</button>
    </td>
  </tr>\`).join('');
}

function renderVip(d) {
  const tb = document.getElementById('vip-table');
  if (!d.vipNumbers.length) { tb.innerHTML = '<tr><td colspan="3" class="empty">لا يوجد أرقام VIP</td></tr>'; return; }
  tb.innerHTML = d.vipNumbers.map(num => \`<tr>
    <td dir="ltr">\${num}</td>
    <td>\${d.userNames[num] || '—'}</td>
    <td><button class="btn btn-r" onclick="removeVipNum('\${num}')">حذف</button></td>
  </tr>\`).join('');
}

function renderReports(d) {
  const tb = document.getElementById('reports-table');
  if (!d.reports.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">لا يوجد بلاغات</td></tr>'; return; }
  tb.innerHTML = d.reports.map((r,i) => \`<tr>
    <td>\${i+1}</td>
    <td>\${r.name || '—'}</td>
    <td dir="ltr" style="font-size:12px">\${r.sender}</td>
    <td>\${r.text}</td>
    <td style="font-size:11px;color:#64748b">\${r.time}</td>
  </tr>\`).join('');
}

async function addVip() {
  const num = document.getElementById('new-vip').value.replace(/\D/g,'');
  if (!num) { toast('أدخل رقماً صحيحاً', '#f59e0b'); return; }
  const r = await api('addVip', { num });
  if (r.ok) { toast('✅ تم إضافة VIP'); document.getElementById('new-vip').value = ''; loadData(); }
}

async function addVipNum(num) {
  const r = await api('addVip', { num });
  if (r.ok) { toast('✅ تم إضافة VIP'); loadData(); }
}

async function removeVipNum(num) {
  if (!confirm('حذف من VIP؟')) return;
  const r = await api('removeVip', { num });
  if (r.ok) { toast('تم الحذف'); loadData(); }
}

async function deleteUser(num) {
  if (!confirm('حذف هذا المستخدم نهائياً؟')) return;
  const r = await api('deleteUser', { num });
  if (r.ok) { toast('تم الحذف'); loadData(); }
}

async function clearReports() {
  if (!confirm('مسح كل البلاغات؟')) return;
  const r = await api('clearReports');
  if (r.ok) { toast('تم مسح البلاغات'); loadData(); }
}

async function doAction(action) {
  if (action === 'clearSessions' && !confirm('مسح كل الجلسات النشطة؟')) return;
  const r = await api(action);
  toast(r.msg || '✅ تم');
  loadData();
}

async function sendBroadcast() {
  const text = document.getElementById('broadcast-text').value.trim();
  if (!text) { toast('اكتب الرسالة أولاً', '#f59e0b'); return; }
  if (!confirm('إرسال لجميع المستخدمين؟')) return;
  const r = await api('broadcast', { text });
  if (r.ok) {
    toast('✅ ' + (r.msg || 'بدأ الإرسال'));
    document.getElementById('broadcast-text').value = '';
  } else {
    toast(r.msg || 'فشل الإرسال', '#dc2626');
  }
}

// تحديث كل 10 ثواني
loadData();
setInterval(loadData, 10000);
</script>
</body>
</html>`);
    });

    server.listen(WEB_PORT, () => {
        console.log(`\n🌐 لوحة التحكم: http://localhost:${WEB_PORT}\n`);
    });

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.log(`⚠️ البورت ${WEB_PORT} مشغول`);
        }
    });
}

// ============================================================
// WELCOME MESSAGE
// ============================================================
function buildWelcome(name) {
    const first    = name ? name.split(' ')[0] : null;
    const greeting = first ? `أهلاً ${first}` : 'أهلاً';
    return `${greeting} 👋\n\nأنا *${BOT_NAME}*، بوت ذكاء اصطناعي على واتساب.\n\nأستطيع مساعدتك في:\n• الإجابة على أي سؤال\n• تحليل الصور والصور الطبية\n• معلومات طبية وعلمية دقيقة\n\nللإبلاغ عن مشكلة اكتب: *!بلاغ* ثم وصف المشكلة\n\nاسأل بدون تردد 🤝`;
}

// ============================================================
// MAIN BOT
// ============================================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version }          = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth:    state,
        browser: Browsers.macOS('Desktop')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            currentQR = qr;
            isConnected = false;
            console.log('\n📱 امسح QR من المتصفح: http://localhost:' + WEB_PORT + '\n');
            QRCode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            currentQR = null;
            isConnected = true;
            console.log('✅ البوت متصل وجاهز!');
            startSchedulers();
        }

        if (connection === 'close') {
            const code           = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log('❌ انقطع الاتصال، الكود:', code);
            if (shouldReconnect) {
                console.log('🔄 إعادة الاتصال خلال 5 ثواني...');
                setTimeout(startBot, 5000);
            } else {
                console.log('🚪 تم تسجيل الخروج. احذف مجلد session وأعد التشغيل.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages?.[0];
        if (!msg?.message || msg?.key?.fromMe) return;

        try {
            const message = msg.message || {};

            // استخراج نوع الرسالة
            const IGNORED_TYPES = new Set([
                'protocolMessage', 'senderKeyDistributionMessage',
                'messageContextInfo', 'reactionMessage', 'pollUpdateMessage'
            ]);
            const msgType = Object.keys(message).find(
                k => message[k] != null && !IGNORED_TYPES.has(k)
            );
            if (!msgType) return;

            const jid     = msg.key?.remoteJid;
            if (!jid) return;

            // تجاهل الجروبات
            if (jid.endsWith('@g.us')) return;

            // استخراج رقم المرسل بشكل موثوق
            const sender = cleanNumber(
                msg.key?.participant || jid
            );
            if (!sender) return;

            const isAdmin = sender === ADMIN_NUMBER;

            // استخراج نص الرسالة
            const body = (
                message?.conversation ||
                message?.extendedTextMessage?.text ||
                message?.imageMessage?.caption ||
                message?.documentMessage?.caption ||
                message?.videoMessage?.caption ||
                ''
            ).trim();

            console.log(`📨 [${isAdmin ? 'ADMIN' : 'USER'}] ${sender} | ${msgType} | "${body.slice(0, 50)}"`);

            const reply = async (text) => {
                try {
                    await sock.sendMessage(jid, { text }, { quoted: msg });
                } catch (e) {
                    console.error('[reply] خطأ:', e.message);
                }
            };

            const react = async (emoji) => {
                try {
                    await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
                } catch {}
            };

            // ============================================================
            // أوامر الأدمن
            // ============================================================
            if (isAdmin) {
                if (safeBody(body, '!مساعدة')) {
                    await reply(
                        `أوامر الأدمن:\n\n` +
                        `!بث [رسالة] — إرسال رسالة لجميع المستخدمين\n` +
                        `!vip [رقم] — إضافة رقم VIP\n` +
                        `!حذف [رقم] — حذف رقم من VIP\n` +
                        `!قائمة — عرض أرقام VIP\n` +
                        `!احصائيات — إحصائيات البوت\n` +
                        `!بلاغات — عرض آخر البلاغات\n` +
                        `!مسح [رقم] — مسح محادثة مستخدم\n` +
                        `!مسح_كل — مسح كل الجلسات النشطة`
                    );
                    return;
                }

                if (body.startsWith('!بث ') || body.startsWith('!broadcast ')) {
                    const text = body.split(' ').slice(1).join(' ').trim();
                    if (!text) { await reply('اكتب الرسالة بعد الأمر.\nمثال: !بث مرحباً بالجميع'); return; }
                    await reply('⏳ جاري الإرسال للجميع...');
                    const r = await broadcastToAll(`📢 *رسالة من الإدارة*\n\n${text}`);
                    await reply(`✅ اكتمل الإرسال\nأُرسل إلى: ${r.sent}\nفشل: ${r.failed}\nالإجمالي: ${r.total}`);
                    return;
                }

                if (body.startsWith('!vip ')) {
                    const num = cleanNumber(body.split(' ')[1] || '');
                    if (!num) { await reply('أدخل رقماً صحيحاً'); return; }
                    if (!vipNumbers.includes(num)) { vipNumbers.push(num); saveData(); }
                    await reply(`✅ تم إضافة ${num} إلى VIP`);
                    return;
                }

                if (body.startsWith('!حذف ')) {
                    const num = cleanNumber(body.split(' ')[1] || '');
                    vipNumbers = vipNumbers.filter(n => n !== num);
                    saveData();
                    await reply(`تم حذف ${num} من VIP`);
                    return;
                }

                if (safeBody(body, '!قائمة')) {
                    await reply(vipNumbers.length
                        ? `قائمة VIP (${vipNumbers.length}):\n\n${vipNumbers.join('\n')}`
                        : 'لا يوجد أرقام VIP حالياً'
                    );
                    return;
                }

                if (safeBody(body, '!احصائيات')) {
                    const welcomedCount = Object.keys(welcomedUsers).length;
                    const activeCount   = Object.keys(userChats).length;
                    await reply(
                        `📊 إحصائيات ${BOT_NAME}\n\n` +
                        `المستخدمون المسجلون: ${welcomedCount}\n` +
                        `الجلسات النشطة: ${activeCount}\n` +
                        `أرقام VIP: ${vipNumbers.length}\n\n` +
                        `الرسائل النصية: ${stats.totalMessages}\n` +
                        `الصور المحللة: ${stats.totalImages}\n` +
                        `الصور الطبية: ${stats.totalMedical}\n` +
                        `البلاغات: ${reports.length}`
                    );
                    return;
                }

                if (safeBody(body, '!بلاغات')) {
                    if (!reports.length) { await reply('لا يوجد بلاغات حالياً'); return; }
                    const last = reports.slice(-10).reverse();
                    let txt = `آخر ${last.length} بلاغات:\n\n`;
                    last.forEach((r, i) => {
                        txt += `${i + 1}. ${r.name || r.sender}\n${r.sender}\n${r.text}\n${r.time}\n\n`;
                    });
                    await reply(txt.trim());
                    return;
                }

                if (body.startsWith('!مسح ')) {
                    const num = cleanNumber(body.split(' ')[1] || '');
                    delete userChats[num];
                    delete welcomedUsers[num];
                    saveData();
                    await reply(`تم مسح بيانات ${num}`);
                    return;
                }

                if (safeBody(body, '!مسح_كل')) {
                    userChats = {};
                    await reply('تم مسح جميع الجلسات النشطة من الذاكرة');
                    return;
                }

                // إذا الأدمن كتب شيئاً غير معروف، يستمر كمستخدم عادي
            }

            // ============================================================
            // نظام الإبلاغ (للجميع)
            // ============================================================
            if (body.startsWith('!بلاغ ') || body.startsWith('!مشكلة ')) {
                const reportText = body.split(' ').slice(1).join(' ').trim();
                if (!reportText) {
                    await reply('اكتب المشكلة بعد الأمر.\nمثال: !بلاغ البوت لم يرد بشكل صحيح');
                    return;
                }
                const report = {
                    sender,
                    name: userNames[sender] || 'غير معروف',
                    text: reportText,
                    time: nowJerusalem().toLocaleString('ar-SA')
                };
                reports.push(report);
                if (reports.length > 500) reports = reports.slice(-500);
                saveData();
                try {
                    await sock.sendMessage(`${ADMIN_NUMBER}@s.whatsapp.net`, {
                        text: `🚨 بلاغ جديد\nالمستخدم: ${report.name}\nالرقم: ${report.sender}\nالمشكلة: ${report.text}\nالوقت: ${report.time}`
                    });
                } catch {}
                await reply('تم استلام بلاغك وسيتم مراجعته. شكراً على تواصلك.');
                await react('✅');
                return;
            }

            // ============================================================
            // استخراج / تحديث اسم المستخدم
            // ============================================================
            let userName = userNames[sender];
            const pushName = msg.pushName?.trim();
            if (pushName && pushName !== userName) {
                userNames[sender] = pushName;
                userName = pushName;
                saveData();
            }

            // ============================================================
            // رسالة الترحيب (للمستخدمين الجدد فقط)
            // ============================================================
            if (!welcomedUsers[sender]) {
                welcomedUsers[sender] = true;
                saveData();
                await reply(buildWelcome(userName));
                // بناء سياق أولي
                userChats[sender] = [];
                if (userName) {
                    userChats[sender].push({ role: 'user',      content: `[اسم المستخدم: ${userName}]` });
                    userChats[sender].push({ role: 'assistant', content: `أهلاً ${userName}، كيف أستطيع مساعدتك؟` });
                }
                return;
            }

            // ============================================================
            // معالجة أنواع الرسائل
            // ============================================================

            // --- صور ---
            if (msgType === 'imageMessage') {
                await react('👍');
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger: { level: 'silent', child: () => ({ level: 'silent' }) }
                    });
                    const isMed = isMedicalImage(body);
                    stats.totalImages++;
                    if (isMed) stats.totalMedical++;
                    saveData();
                    const res = await askAIWithImage(buffer.toString('base64'), body, userName);
                    await reply(res);
                    await react('✅');
                } catch (e) {
                    console.error('[image]', e.message);
                    await reply('لم أتمكن من تحليل الصورة، يرجى المحاولة مرة أخرى.');
                    await react('❌');
                }
                return;
            }

            // --- ملفات ---
            if (msgType === 'documentMessage') {
                await react('ℹ️');
                await reply(
                    `عذراً، الملفات غير مدعومة حالياً.\n\n` +
                    `ما يدعمه ${BOT_NAME}:\n` +
                    `الرسائل النصية\n` +
                    `الصور وتحليلها\n` +
                    `الصور الطبية\n\n` +
                    `يمكنك نسخ محتوى الملف وإرساله كنص.`
                );
                return;
            }

            // --- فيديو ---
            if (msgType === 'videoMessage') {
                await react('ℹ️');
                await reply(
                    `عذراً، الفيديوهات غير مدعومة حالياً.\n\n` +
                    `ما يدعمه ${BOT_NAME}:\n` +
                    `الرسائل النصية\n` +
                    `الصور وتحليلها\n` +
                    `الصور الطبية`
                );
                return;
            }

            // --- صوت ---
            if (msgType === 'audioMessage' || msgType === 'pttMessage') {
                await react('ℹ️');
                await reply(
                    `عذراً، الرسائل الصوتية غير مدعومة حالياً.\n\n` +
                    `ما يدعمه ${BOT_NAME}:\n` +
                    `الرسائل النصية\n` +
                    `الصور وتحليلها\n` +
                    `الصور الطبية`
                );
                return;
            }

            // --- نص ---
            if (!body) return;

            await react('👍');

            if (!userChats[sender]) userChats[sender] = [];

            // سياق أولي إذا كانت الجلسة فارغة
            if (userChats[sender].length === 0 && userName) {
                userChats[sender].push({ role: 'user',      content: `[اسم المستخدم: ${userName}]` });
                userChats[sender].push({ role: 'assistant', content: `أهلاً ${userName}، كيف أستطيع مساعدتك؟` });
            }

            userChats[sender].push({ role: 'user', content: body });
            stats.totalMessages++;
            saveData();

            // تقليم السياق
            if (userChats[sender].length > MAX_HISTORY)
                userChats[sender] = userChats[sender].slice(-MAX_HISTORY);

            const res = await askAI([
                { role: 'system', content: SYSTEM_PROMPT },
                ...userChats[sender]
            ]);

            userChats[sender].push({ role: 'assistant', content: res });

            await reply(res);
            await react('✅');

        } catch (error) {
            console.error('[messages.upsert]', error.message);
            try {
                await sock.sendMessage(
                    msg.key.remoteJid,
                    { text: 'حدث خطأ تقني، يرجى المحاولة مرة أخرى.' },
                    { quoted: msg }
                );
            } catch {}
        }
    });
}

// مساعد بسيط للمقارنة الكاملة
function safeBody(body, cmd) { return body === cmd; }

// ============================================================
// START
// ============================================================
console.log(`🚀 جاري تشغيل ${BOT_NAME}...`);
startQRServer();
startBot();
