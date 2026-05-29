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
        if (req.url === '/qr-image' && currentQR) {
            try {
                const imgBuffer = await QRCodeImg.toBuffer(currentQR, {
                    errorCorrectionLevel: 'H',
                    width: 400,
                    margin: 2
                });
                res.writeHead(200, { 'Content-Type': 'image/png' });
                res.end(imgBuffer);
            } catch {
                res.writeHead(500); res.end();
            }
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="5">
<title>${BOT_NAME} - ربط واتساب</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; background: #0f172a; color: #e2e8f0; min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { background: #1e293b; border-radius: 20px; padding: 40px; text-align: center; max-width: 440px; width: 90%; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
  h1 { color: #38bdf8; font-size: 24px; margin-bottom: 8px; }
  .sub { color: #64748b; font-size: 14px; margin-bottom: 30px; }
  .qr-box { background: white; border-radius: 16px; padding: 16px; display: inline-block; margin-bottom: 24px; }
  .qr-box img { display: block; width: 280px; height: 280px; }
  .status { padding: 10px 20px; border-radius: 99px; font-size: 14px; font-weight: 600; display: inline-block; }
  .status.waiting { background: rgba(245,158,11,0.15); color: #f59e0b; }
  .status.connected { background: rgba(34,197,94,0.15); color: #22c55e; }
  .status.loading { background: rgba(56,189,248,0.15); color: #38bdf8; }
  .steps { margin-top: 24px; text-align: right; background: #0f172a; border-radius: 12px; padding: 16px; }
  .steps p { font-size: 13px; color: #94a3b8; margin-bottom: 6px; }
  .steps p span { color: #38bdf8; font-weight: 600; }
  .refresh { margin-top: 16px; font-size: 12px; color: #475569; }
</style>
</head>
<body>
<div class="card">
  <h1>🤖 ${BOT_NAME}</h1>
  <p class="sub">ربط واتساب</p>

  ${isConnected ? `
    <div style="font-size:64px; margin-bottom:16px;">✅</div>
    <span class="status connected">متصل وشغال!</span>
  ` : currentQR ? `
    <div class="qr-box">
      <img src="/qr-image" alt="QR Code"/>
    </div>
    <br>
    <span class="status waiting">في انتظار المسح...</span>
    <div class="steps">
      <p><span>1.</span> افتح واتساب على هاتفك</p>
      <p><span>2.</span> اضغط النقاط الثلاث ← الأجهزة المرتبطة</p>
      <p><span>3.</span> اضغط "ربط جهاز"</p>
      <p><span>4.</span> امسح الكود أعلاه</p>
    </div>
  ` : `
    <div style="font-size:48px; margin-bottom:16px;">⏳</div>
    <span class="status loading">جاري التحميل...</span>
  `}

  <p class="refresh">تتجدد الصفحة كل 5 ثواني</p>
</div>
</body>
</html>`);
    });

    server.listen(WEB_PORT, () => {
        console.log(`\n🌐 افتح في المتصفح: http://localhost:${WEB_PORT}`);
        console.log(`📱 أو من هاتفك: http://127.0.0.1:${WEB_PORT}\n`);
    });

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.log(`⚠️ البورت ${WEB_PORT} مشغول، جرب: http://localhost:${WEB_PORT}`);
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
