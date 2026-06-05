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
const pdfParse = require('pdf-parse');
const QRCodeImg = require('qrcode');
const http = require('http');
const fs   = require('fs');


// ============================================================
// CONFIG
// ============================================================
const MISTRAL_API_KEY = 'fZ0TSrAOJK3cBjkmj461Msqhk90d0HiL';

if (!MISTRAL_API_KEY) {
    console.error('❌ خطأ فادح: لم يتم تعيين MISTRAL_API_KEY!');
    process.exit(1);
}
const ADMIN_NUMBER    = '972593850520';   // بدون + أو @
const BOT_NAME        = 'MedTerm';
const DATA_FILE       = './bot_data.json';
const WEB_PORT        = 8080;

// ============================================================
// DASHBOARD AUTH
// ============================================================
const DASHBOARD_USER  = '1122134';
const DASHBOARD_PASS  = '1125567';
const crypto          = require('crypto');
// sessions: { token: { ip, createdAt } }
const _sessions       = {};
const SESSION_TTL_MS  = 12 * 60 * 60_000; // 12 ساعة

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}
function isValidSession(req) {
    const token = parseCookie(req.headers['cookie'] || '')['adm_tok'];
    if (!token || !_sessions[token]) return false;
    const s = _sessions[token];
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
        delete _sessions[token];
        return false;
    }
    s.createdAt = Date.now(); // تجديد تلقائي عند كل طلب
    return true;
}
function parseCookie(str) {
    return Object.fromEntries(
        str.split(';').map(c => c.trim().split('=').map(p => decodeURIComponent(p.trim())))
            .filter(p => p.length === 2)
    );
}
// تنظيف sessions منتهية كل ساعة
setInterval(() => {
    const now = Date.now();
    for (const tok of Object.keys(_sessions))
        if (now - _sessions[tok].createdAt > SESSION_TTL_MS) delete _sessions[tok];
}, 60 * 60_000);

let currentQR = null;
let isConnected = false;
const MAX_HISTORY     = 30;              // أقصى رسائل في السياق
const API_TIMEOUT_MS  = 60_000;         // 60 ثانية timeout للـ API (pixtral-large يحتاج وقت أكثر)

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
        vipExpiry:      {},   // { sender: timestamp_ms } — تاريخ انتهاء VIP
        reports:        [],
        userLimits:     {},   // حدود مخصصة لكل مستخدم { sender: limit }
        blacklist:      [],   // أرقام محظورة
        userLanguages:  {},   // لغة كل مستخدم { sender: 'ar'|'en'|... }
        stats:          { totalMessages: 0, totalImages: 0, totalMedical: 0, totalDocs: 0 }
    };
}

let _saveTimer = null;
function saveData() {
    // debounce: تأخير 200ms
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try {
            const tmp = DATA_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(
                { userNames, welcomedUsers, vipNumbers, vipExpiry, reports, userLimits, blacklist, userLanguages, stats },
                null, 2
            ));
            fs.renameSync(tmp, DATA_FILE);
        } catch (e) {
            console.error('[saveData] خطأ:', e.message);
        }
    }, 500);
}

let { userNames, welcomedUsers, vipNumbers, vipExpiry, reports, userLimits, blacklist, userLanguages, stats } = loadData();

// ضمان وجود الحقول
if (!Array.isArray(reports))   reports = [];
if (!userLimits)               userLimits = {};
if (!Array.isArray(blacklist)) blacklist = [];
if (!userLanguages)            userLanguages = {};
if (!vipExpiry)                vipExpiry = {};
if (!stats)                    stats   = { totalMessages: 0, totalImages: 0, totalMedical: 0, totalDocs: 0 };
if (!stats.totalMessages)      stats.totalMessages = 0;
if (!stats.totalImages)        stats.totalImages   = 0;
if (!stats.totalMedical)       stats.totalMedical  = 0;
if (!stats.totalDocs)          stats.totalDocs     = 0;

// إضافة الأدمن للمستخدمين المرحّب بهم تلقائياً حتى لا يستقبل رسالة ترحيب
welcomedUsers[ADMIN_NUMBER] = true;
saveData();

let userChats       = {};   // سياق المحادثة (RAM فقط)
let userChatLastSeen = {}; // آخر نشاط لكل مستخدم
let userModes       = {};  // وضع كل مستخدم: 'terms' | 'pharma' | 'medai' | 'openai' | null
let userTTSPending  = {};  // { sender: { term, lang, expiresAt } } — انتظار "نعم" لإرسال النطق
let userPdfContext  = {};  // { sender: { fileName, docText } } — محتوى PDF النشط
let userPdfPending  = {};  // { sender: { fileName, docText, expiresAt } } — انتظار إذن المستخدم
let sock            = null;
let isReconnecting  = false; // منع الاتصال المتعدد

// تنظيف الذاكرة: احتفظ بآخر 800 جلسة الأكثر نشاطاً (LRU)
function cleanMemory() {
    const keys = Object.keys(userChats);
    if (keys.length > 800) {
        const sorted = keys.sort((a, b) => (userChatLastSeen[a] || 0) - (userChatLastSeen[b] || 0));
        const toDelete = sorted.slice(0, keys.length - 800);
        toDelete.forEach(k => { delete userChats[k]; delete userChatLastSeen[k]; });
        console.log(`[cleanMemory] حُذف ${toDelete.length} جلسة قديمة (LRU)`);
    }
}

// فحص دوري لانتهاء اشتراكات VIP
function checkVIPExpiry() {
    const now = Date.now();
    let changed = false;
    for (const num of [...vipNumbers]) {
        const expiry = vipExpiry[num];
        if (expiry && now > expiry) {
            vipNumbers = vipNumbers.filter(n => n !== num);
            delete vipExpiry[num];
            changed = true;
            console.log(`[VIP] انتهى اشتراك المستخدم ${num}`);
            if (sock && isConnected) {
                sock.sendMessage(`${num}@s.whatsapp.net`, {
                    text: '⚠️ انتهت صلاحية اشتراكك المميز (VIP).\n\nللتجديد تواصل مع المهندس نادر:\n👤 wa.me/972593850520'
                }).catch(() => {});
            }
        }
    }
    if (changed) saveData();
}

// ============================================================
// PURE HELPERS (no dependencies — must come before SYSTEM PROMPTS)
// ============================================================

// توقيت القدس — طريقة موثوقة على جميع البيئات (Linux/Windows/Mac)
function nowJerusalem() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jerusalem',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    });
    const parts = fmt.formatToParts(now);
    const get = type => parts.find(p => p.type === type)?.value || '00';
    // نستخرج القيم بتوقيت القدس ونبني التاريخ كـ local time صريح
    // الهدف: الحصول على كائن Date يمثّل "الآن بتوقيت القدس" للحسابات الداخلية
    const isoStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+00:00`;
    return new Date(isoStr);
}

// ============================================================
// RATE LIMITING & DAILY MESSAGE QUOTA
// ============================================================
const DAILY_MSG_LIMIT   = 20; // رسائل نصية/24 ساعة لكل مستخدم عادي
const DAILY_IMG_LIMIT   = 5;  // صور يومياً للمستخدم العادي
const DAILY_TTS_LIMIT   = 10; // مرات استخدام الصوت/الترجمة يومياً للمستخدم العادي
const BLACKLIST_MSG   = '⛔ عذراً، تم حظرك من استخدام هذا البوت.\nللاستفسار تواصل مع المهندس نادر:\n👤 wa.me/972593850520'; // رسالة للمحظورين
const _userDailyLimit = {}; // { sender: { messages, images, docs, tts, resetAt } }

// الحد اليومي الفعلي: مخصص إن وُجد، وإلا الافتراضي
function getUserDailyLimit(sender) {
    return (userLimits && userLimits[sender] != null) ? userLimits[sender] : DAILY_MSG_LIMIT;
}

// حساب بداية اليوم التالي (منتصف الليل بتوقيت القدس)
function getNextMidnightMs() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jerusalem',
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = fmt.formatToParts(now);
    const get = type => parts.find(p => p.type === type)?.value || '00';
    // منتصف ليل اليوم التالي بتوقيت القدس
    const todayMidnightJerusalem = new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00`);
    todayMidnightJerusalem.setDate(todayMidnightJerusalem.getDate() + 1);
    return todayMidnightJerusalem.getTime();
}

function getDailyRecord(sender) {
    const now = Date.now();
    if (!_userDailyLimit[sender] || now >= _userDailyLimit[sender].resetAt) {
        _userDailyLimit[sender] = {
            messages: 0,
            images:   0,
            docs:     0,
            tts:      0,
            resetAt:  getNextMidnightMs()
        };
    }
    return _userDailyLimit[sender];
}

// فحص الحد اليومي للرسائل النصية — يُعيد { allowed, remaining, commit }
// commit() يجب استدعاؤها فقط بعد نجاح إرسال الرد الفعلي
function checkDailyMessages(sender) {
    const limit = getUserDailyLimit(sender);
    const rec = getDailyRecord(sender);
    if (rec.messages >= limit) return { allowed: false, remaining: 0, limit, commit: () => {} };
    const remaining = limit - rec.messages - 1;
    const commit = () => { rec.messages++; };
    return { allowed: true, remaining, limit, commit };
}

// فحص الحد اليومي للـ TTS — يُعيد { allowed, remaining }
function checkDailyTTS(sender) {
    const d = getDailyRecord(sender);
    if (d.tts >= DAILY_TTS_LIMIT) return { allowed: false, remaining: 0 };
    const remaining = DAILY_TTS_LIMIT - d.tts - 1;
    d.tts++;
    return { allowed: true, remaining };
}

// فحص الحد اليومي للصور والملفات
function checkDailyLimit(sender, type) {
    const d = getDailyRecord(sender);
    if (type === 'image') { if (d.images >= DAILY_IMG_LIMIT) return false; d.images++; return true; }
    if (type === 'pdf')   { if (d.docs   >= 10) return false; d.docs++;   return true; }
    return true;
}

// التحقق من VIP مع الانتهاء التلقائي
function isActiveVIP(sender) {
    if (!vipNumbers.includes(sender)) return false;
    const expiry = vipExpiry[sender];
    if (!expiry) return true; // بدون تاريخ انتهاء = دائم
    if (Date.now() > expiry) {
        // انتهى الاشتراك — إزالة تلقائية
        vipNumbers = vipNumbers.filter(n => n !== sender);
        delete vipExpiry[sender];
        saveData();
        // إشعار المستخدم
        if (sock && isConnected) {
            sock.sendMessage(`${sender}@s.whatsapp.net`, {
                text: '⚠️ انتهت صلاحية اشتراكك المميز (VIP).\n\nللتجديد تواصل مع المهندس نادر:\n👤 wa.me/972593850520'
            }).catch(() => {});
        }
        return false;
    }
    return true;
}
const _spamCheck = {}; // { sender: [timestamps] }
function checkSpam(sender) {
    const now = Date.now();
    if (!_spamCheck[sender]) _spamCheck[sender] = [];
    _spamCheck[sender] = _spamCheck[sender].filter(t => now - t < 5_000);
    if (_spamCheck[sender].length >= 3) return false; // spam
    _spamCheck[sender].push(now);
    return true;
}

// تنظيف سجلات anti-spam كل ساعة
setInterval(() => {
    const now = Date.now();
    for (const k of Object.keys(_spamCheck)) {
        _spamCheck[k] = (_spamCheck[k] || []).filter(t => now - t < 10_000);
        if (!_spamCheck[k].length) delete _spamCheck[k];
    }
    // تنظيف سجلات Daily المنتهية
    for (const k of Object.keys(_userDailyLimit)) {
        if (now >= (_userDailyLimit[k].resetAt || 0)) delete _userDailyLimit[k];
    }
}, 60 * 60_000);

// ============================================================
// SYSTEM PROMPTS
// ============================================================
let _cachedSystemPrompt = null;
let _cachedSystemPromptTime = 0;
function getSystemPrompt() {
    const nowMs = Date.now();
    if (_cachedSystemPrompt && nowMs - _cachedSystemPromptTime < 60_000)
        return _cachedSystemPrompt;
    _cachedSystemPromptTime = nowMs;
    const now = nowJerusalem();
    const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
    const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    const dateStr = `${days[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
    const timeStr = now.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
    _cachedSystemPrompt = `اسمك "MedTerm"، مساعد ذكاء اصطناعي شامل على واتساب.\n\nالتاريخ والوقت الحالي: ${dateStr} - الساعة ${timeStr} (بتوقيت القدس)\nاستخدم هذا التاريخ دائماً عند أي سؤال عن اليوم أو التاريخ أو السنة، ولا تعتمد على معلوماتك القديمة أبداً.\n\nشخصيتك:\n- مساعد شامل ومتعدد المعرفة: تجيب على أي سؤال في أي مجال بدون استثناء\n- جدي ومهني، ردودك دقيقة ومباشرة بدون حشو أو مقدمات زائدة\n- اللغة الافتراضية عربية واضحة وسهلة، وإذا طلب المستخدم لغة أخرى تحدّث بها فوراً\n- أعطِ المعلومة الكاملة والصحيحة من أول رد\n- نظّم ردودك بشكل واضح: استخدم النقاط والعناوين والترقيم عند الحاجة لتسهيل القراءة\n- لا تستخدم مصطلحات أجنبية غير ضرورية\n- اقرأ سياق المحادثة كاملاً وربط الرسائل ببعضها قبل الرد\n- إذا سُئلت عن اسمك قل: أنا MedTerm، مساعد ذكاء اصطناعي\n- تتعامل مع جميع المستخدمين باحترام بغض النظر عن جنسيتهم أو لغتهم\n\nمجالات خبرتك (غير محدودة):\n- الطب والصحة: معلومات دقيقة، أدوية، جرعات، أعراض، تشخيص أولي — مع التنبيه بمراجعة الطبيب للحالات الجدية\n- العلوم والتقنية: برمجة، ذكاء اصطناعي، رياضيات، فيزياء، كيمياء\n- القانون والأعمال: معلومات عامة، عقود، ريادة أعمال، تسويق\n- التاريخ والجغرافيا والثقافة العامة\n- الدين والفقه: إجابات موضوعية ومتوازنة\n- الأدب والكتابة والترجمة\n- الطبخ والسفر ونمط الحياة\n- أي موضوع آخر يسألك عنه المستخدم\n\nقاعدة ذهبية: لا تقل أبداً "هذا خارج نطاق تخصصي" — أجب على كل سؤال بأفضل ما لديك.\n\nاسم المستخدم موجود في السياق، استخدمه أحياناً بشكل طبيعي.`
    return _cachedSystemPrompt;
}

// ============================================================
// SYSTEM PROMPTS للأنظمة الأربعة
// ============================================================
const MODE_PROMPTS = {
    terms: `أنت متخصص حصري في المصطلحات الطبية لجميع التخصصات الطبية. مهمتك الوحيدة هي شرح المصطلحات الطبية بشكل علمي ومتكامل.

══════════════════════════════
قواعد النظام — يجب اتباعها بدقة تامة:
══════════════════════════════

1) اقبل أي إدخال له صلة بالمجال الطبي والصحي بأي شكل كان:
— مصطلح طبي رسمي: Meningitis · التهاب السحايا · Tachycardia
— كلمة طبية بسيطة: قلب · كبد · دم · عظم · heart · liver
— اسم مرض أو حالة: سكري · ضغط · ربو · سرطان · diabetes
— اسم عضو أو جهاز: بنكرياس · الغدة الدرقية · pancreas
— اسم دواء أو علاج: بنسيلين · أسبرين · penicillin
— إجراء أو فحص: تحليل دم · رنين · MRI · خزعة
— أعراض: صداع · ألم صدر · headache
— أي كلمة أو مفهوم أو تعريف في المجال الطبي والصحي

إذا أرسل المستخدم شيئاً لا علاقة له بالطب أو الصحة نهائياً (مثل: أسعار، طبخ، رياضة، سياسة، برمجة) رد بهذه الرسالة الثابتة فقط:

⚠️ هذا النظام مخصص للمجال الطبي والصحي فقط.
الرجاء إرسال أي كلمة أو مصطلح أو مفهوم طبي.

📋 أمثلة:
بالعربية: قلب · سكري · التهاب · ضغط · كبد · سرطان · أسبرين · رنين مغناطيسي
In English: heart · diabetes · inflammation · MRI · cancer · aspirin · fever

💡 لتغيير النظام اكتب: !قائمة

══════════════════════════════

2) إذا أرسل المستخدم أي كلمة أو مصطلح أو مفهوم له علاقة بالطب والصحة (بالعربية أو الإنجليزية أو كليهما)، اردّ بهذا النموذج الكامل والثابت بالضبط دون أي تغيير في الترتيب أو الشكل أو الأيقونات:

📌 المصطلح
[المصطلح بالإنجليزية]
[المصطلح بالعربية]

🌐 أصل المصطلح
[اذكر هنا: يوناني / لاتيني / إنجليزي] من "[الكلمة الأصلية]" = [المعنى الحرفي] · "[الجزء الثاني إن وجد]" = [المعنى]

🗣️ النطق — Pronunciation
بالعربية: [النطق الصوتي الكامل بمقاطع واضحة مثال: مِـنِـنْـجَـايْـتِـس]
In English: [English phonetic pronunciation مثال: men·in·JY·tis]
🔤 IPA: [/الرموز الصوتية الدولية/]

🔸 المعنى المختصر
[تعريف دقيق ومختصر في سطر أو سطرين]

📖 الشرح الطبي
🔹 بالعربية: [فقرة علمية واضحة تشمل: ما هو المصطلح، أسبابه الرئيسية، أعراضه، وأهميته السريرية — بشكل مدمج ومتدفق وليس نقاطاً]
🔹 In English: [Clear scientific paragraph covering: what it is, main causes, symptoms, and clinical significance — flowing text not bullet points]

━━ 🧬 تحليل المصطلح ━━
🌱 الجذر: [الجذر]←[معنى الجذر بالعربية / meaning in English]
⬅️ البادئة: [البادئة إن وجدت، وإلا اكتب: لا يوجد]
➡️ اللاحقة: [اللاحقة]←[معناها بالعربية / meaning]
📐 [البادئة +] [الجذر] + [اللاحقة] = [المعنى الحرفي الكامل]

🫀 الجهاز المصاب
[الجهاز أو الأعضاء المصابة]

🦠 الأمراض المرتبطة
[اذكر 4-5 أمراض مرتبطة بصيغة:
Disease Name — الاسم بالعربية: وصف مختصر جداً]

⚕️ التخصص الطبي
[التخصصات الطبية المعنية]

🔗 مصطلحات مرتبطة
[5 مصطلحات بصيغة: Term — الترجمة العربية]

💡 نصائح سريعة
• [نصيحة 1]
• [نصيحة 2]
• [نصيحة 3]

📝 أمثلة تطبيقية
بالعربية: [جملة كاملة في سياق طبي حقيقي]
In English: [Full sentence in a real medical context]

🎓 Learning Note
[فقرة تعليمية بالإنجليزية للطلاب والمهنيين الصحيين: الأهمية السريرية وكيفية التمييز والممارسة العملية]`,

    pharma: `أنت صيدلاني متخصص وخبير في علم الأدوية لجميع التخصصات الطبية. أجب على أي سؤال يتعلق بالأدوية.
عندما يسأل المستخدم عن دواء أو مادة فعّالة، اردّ بهذا النموذج الثابت:

⭐ [الاسم العلمي بالإنجليزية] — [الاسم بالعربية]

---

1) الاسم العلمي — Scientific Name
العربية: [الاسم]
English: [The name]

---

2) الأسماء التجارية — Trade Names
[قائمة الأسماء التجارية المشهورة]

---

3) التصنيف الدوائي — Drug Class
العربية: [التصنيف]
English: [Classification]

---

4) آلية العمل — Mechanism of Action
العربية: [الشرح]
English: [Explanation]

---

5) الاستخدامات — Indications
العربية: [القائمة]
English: [List]

---

6) الجرعة — Dosage
العربية: [الجرعة المعتادة]
English: [Usual dose]

---

7) الآثار الجانبية — Side Effects
العربية: [الشائعة والخطيرة]
English: [Common & serious]

---

8) موانع الاستعمال — Contraindications
العربية: [القائمة]
English: [List]

---

9) التفاعلات الدوائية — Drug Interactions
العربية: [أهم التفاعلات]
English: [Key interactions]

---

⚠️ تنبيه: هذه المعلومات للتثقيف الصحي فقط. استشر طبيبك أو صيدلانيك قبل أخذ أي دواء.

────────────
💡 لتغيير النظام اكتب: !قائمة`,

    medai: `أنت مساعد طبي ذكي ومتخصص في جميع التخصصات الطبية والعلوم الصحية. أجب على أي سؤال طبي بدقة ومهنية.
تشمل تخصصاتك: الطب العام، الجراحة، الأمراض الباطنية، طب الأطفال، أمراض النساء والتوليد، الأمراض العصبية، أمراض القلب، الأمراض الجلدية، طب العيون، طب الأسنان، الطب النفسي، التغذية والصحة العامة، وجميع التخصصات الأخرى.
إذا سأل المستخدم عن موضوع خارج المجال الطبي تماماً، رد بـ:
"⚕️ هذا النظام مخصص للمجال الطبي فقط. يرجى طرح أسئلة طبية أو صحية.
💡 للانتقال لنظام مفتوح اكتب: !قائمة"
اختم ردودك الطبية دائماً بـ: "⚠️ للتشخيص والعلاج يجب مراجعة طبيب متخصص."
────────────
💡 لتغيير النظام اكتب: !قائمة`,

    openai: null  // يستخدم getSystemPrompt() الأصلي
};

// رسالة الترحيب للمستخدمين الجدد
function buildModeMenu(name) {
    const first = name ? name.split(' ')[0] : null;
    const greeting = first ? `أهلاً ${first}` : 'أهلاً';
    return `${greeting} 👋\n\n*مرحباً بك في بوت MedTerm الطبي!*\n\n` +
        `يمكنني مساعدتك في:\n` +
        `🏥 شرح المصطلحات الطبية بالعربي والإنجليزي\n` +
        `💊 معلومات شاملة عن الأدوية والمستحضرات\n` +
        `⚕️ الإجابة على الأسئلة الطبية والصحية\n` +
        `🤖 المساعدة في أي موضوع عام\n` +
        `🖼️ تحليل الصور والتقارير الطبية\n` +
        `📄 قراءة وتحليل ملفات PDF\n` +
        `🔊 نطق المصطلحات الطبية صوتياً\n` +
        `🌐 الترجمة مع الصوت والنطق\n\n` +
        `─────────────────\n` +
        `✍️ *فقط أرسل سؤالك وسأرد عليك مباشرة!*`;
}

// اسم وأيقونة النظام الحالي
function getModeName(mode) {
    const names = {
        terms:  '📌 المصطلحات الطبية',
        pharma: '💊 علم الأدوية',
        medai:  '⚕️ ذكاء صناعي طبي',
        openai: '🤖 ذكاء صناعي عام'
    };
    return names[mode] || 'غير محدد';
}

// System prompt للنظام الحالي
function getModeSystemPrompt(mode) {
    if (!mode || mode === 'openai') return getSystemPrompt();
    const base = MODE_PROMPTS[mode];
    if (!base) return getSystemPrompt();
    // نضيف معلومات التاريخ والوقت من getSystemPrompt
    const now = nowJerusalem();
    const days = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
    const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    const dateStr = `${days[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
    const timeStr = now.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
    return `${base}\n\nالتاريخ والوقت الحالي: ${dateStr} - الساعة ${timeStr} (بتوقيت القدس)`;
}

// كشف إذا كانت الرسالة تتعلق بالمجال الطبي
function isMedicalQuery(text) {
    return /دواء|دوا|حبة|علاج|مرض|أعراض|جرعة|وصفة|صيدلي|طبيب|مستشفى|عملية|سكري|ضغط|قلب|كبد|كلى|دم|تحليل|أشعة|رنين|سرطان|التهاب|ألم|حرارة|انفلونزا|covid|corona|كورونا|فيروس|بكتيريا|مضاد حيوي|بنسيلين|ابتوفين|باراسيتامول|اسبرين|ميزوبروستول|فيتامين|هرمون|انسولين|قرحة|ربو|صداع|دوخة|غثيان|اقياء|اسهال|امساك|جلد|عظم|مفصل|عصب|نفسي|اكتئاب|قلق|ضغط دم|كوليسترول|triglyceride|glucose|hemoglobin|wbc|rbc|platelet|creatinine|uric acid|bilirubin|الت|الغدة|بنكرياس|زائدة|حوصلة|الكوليرا|ملاريا|هيباتيتس|hepatitis|diabetes|hypertension|infection|antibiotic|surgery|physician|hospital|diagnosis|prescription|symptom|medication|dosage|overdose|allergy|immune|vaccine|cholesterol|مصطلح طبي|anatomy|physiology|pathology|pharmacology|medical|medicine|health|صحة|طب|صيدلة/i.test(text || '');
}

// اختيار System Prompt الذكي بناءً على محتوى الرسالة
function getSmartSystemPrompt(text, userLang) {
    const langSuffix = (userLang && userLang !== 'ar')
        ? `\n\nمهم: يجب أن تجيب على هذا المستخدم بلغة "${userLang}" فقط، حتى لو كتب بالعربية.`
        : '';

    if (isMedicalQuery(text)) {
        // استخدام موجّه الطبي الشامل
        return getModeSystemPrompt('medai') + langSuffix;
    }
    // الموجّه العام للأسئلة غير الطبية
    return getSystemPrompt() + langSuffix;
}

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
// TEXT-TO-SPEECH HELPERS
// ============================================================
const path = require('path');

// استخراج المصطلح الإنجليزي من نص الرد
function extractTermForTTS(botReply) {
    const lines = botReply.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 8)) {
        const clean = line.replace(/[📌⭐━─\-\*_#►•]/g, '').trim();
        const englishWords = clean.match(/[A-Za-z][A-Za-z\s\-]+/g);
        if (englishWords) {
            const term = englishWords[0].trim();
            if (term.length >= 3 && term.length <= 80) return term;
        }
    }
    return null;
}

// ============================================================
// TEXT-TO-SPEECH (Google Translate TTS → ffmpeg → OGG Opus)
// ============================================================
const { execFile } = require('child_process');
const os           = require('os');

async function generateTTS(text, lang = 'en') {
    const ttsLang   = lang === 'ar' ? 'ar' : 'en';
    const cleanText = text.slice(0, 100).replace(/[^\w\s\u0600-\u06FF]/g, '');
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(cleanText)}&tl=${ttsLang}&client=tw-ob&ttsspeed=0.9`;

    // الخطوة 1: جلب MP3 من Google TTS
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google TTS HTTP ${response.status}`);
    const mp3Buffer = Buffer.from(await response.arrayBuffer());
    if (!mp3Buffer || mp3Buffer.length < 100) throw new Error(`MP3 فارغ (${mp3Buffer?.length} bytes)`);

    // الخطوة 2: تحويل MP3 → OGG Opus عبر ffmpeg (WhatsApp يحتاج Opus)
    const tmpId  = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const mp3File = require('path').join(os.tmpdir(), `tts_${tmpId}.mp3`);
    const oggFile = require('path').join(os.tmpdir(), `tts_${tmpId}.ogg`);

    await require('fs').promises.writeFile(mp3File, mp3Buffer);

    await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
            '-y', '-i', mp3File,
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-vn',
            oggFile
        ], { timeout: 15_000 }, (err) => {
            require('fs').unlink(mp3File, () => {});
            if (err) return reject(new Error(`ffmpeg فشل: ${err.message}`));
            resolve();
        });
    });

    const oggBuffer = await require('fs').promises.readFile(oggFile);
    require('fs').unlink(oggFile, () => {});

    if (!oggBuffer || oggBuffer.length < 100) throw new Error(`OGG فارغ (${oggBuffer?.length} bytes)`);
    console.log(`[TTS] ✅ ${lang} "${text.slice(0,30)}" → ${oggBuffer.length} bytes`);
    return oggBuffer;
}

// إرسال voice note لـ WhatsApp
async function sendVoiceNote(jid, audioBuffer, quotedMsg) {
    const opts = quotedMsg ? { quoted: quotedMsg } : {};
    await sock.sendMessage(jid, {
        audio:    audioBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt:      true
    }, opts);
}

// تنظيف TTS pending و PDF pending المنتهية كل 10 دقائق
setInterval(() => {
    const now = Date.now();
    for (const k of Object.keys(userTTSPending)) {
        if (now > (userTTSPending[k].expiresAt || 0)) delete userTTSPending[k];
    }
    for (const k of Object.keys(userPdfPending)) {
        if (now > (userPdfPending[k].expiresAt || 0)) delete userPdfPending[k];
    }
}, 10 * 60_000);

// ============================================================
// AI FUNCTIONS
// ============================================================
// Semaphore: أقصى 15 طلباً متزامناً للـ AI (زيادة السرعة)
let _aiActive = 0;
const _aiQueue = [];
function aiSemaphore() {
    return new Promise(resolve => {
        function tryAcquire() {
            if (_aiActive < 15) { _aiActive++; resolve(() => { _aiActive--; if (_aiQueue.length) _aiQueue.shift()(); }); }
            else { _aiQueue.push(tryAcquire); }
        }
        tryAcquire();
    });
}

// إشعار الأدمن بمشاكل حرجة
let _lastAdminNotify = {}; // throttle: لا نرسل نفس التنبيه أكثر من مرة كل 30 دقيقة

// تنظيف _lastAdminNotify كل ساعة — منع memory leak بعد أسابيع من التشغيل
setInterval(() => {
    const now = Date.now();
    for (const k of Object.keys(_lastAdminNotify)) {
        if (now - _lastAdminNotify[k] > 24 * 60 * 60_000)
            delete _lastAdminNotify[k];
    }
}, 60 * 60_000);

async function notifyAdmin(message) {
    const key = message.slice(0, 30);
    const now = Date.now();
    if (_lastAdminNotify[key] && now - _lastAdminNotify[key] < 30 * 60_000) return;
    _lastAdminNotify[key] = now;
    try {
        if (sock && isConnected) {
            await sock.sendMessage(`${ADMIN_NUMBER}@s.whatsapp.net`, { text: message });
        }
    } catch (e) {
        console.error('[notifyAdmin] فشل:', e.message);
    }
}

async function callMistral(payload, retries = 3) {
    const release = await aiSemaphore();
    let lastError = new Error('لم تكتمل أي محاولة');
    try {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const response = await fetchWithTimeout(
                    'https://api.mistral.ai/v1/chat/completions',
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(payload)
                    }
                );

                // Rate limit: انتظر أطول مع كل محاولة
                if (response.status === 429) {
                    const wait = Math.min(3000 * Math.pow(2, attempt), 30_000);
                    console.warn(`[Mistral] rate limit (429)، انتظار ${wait/1000}ث... (محاولة ${attempt + 1}/${retries + 1})`);
                    lastError = new Error('RATE_LIMIT');
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }

                // خطأ في المصادقة — API Key منتهي أو غلط
                if (response.status === 401) {
                    console.error('[Mistral] ❌ خطأ 401: API Key غير صالح أو منتهي الصلاحية!');
                    notifyAdmin('⚠️ تنبيه: Mistral API Key غير صالح (401). البوت لن يرد على الرسائل حتى يتم تحديث الـ Key.');
                    throw new Error('AUTH_ERROR');
                }

                // نفاد الرصيد
                if (response.status === 402) {
                    console.error('[Mistral] ❌ خطأ 402: نفاد رصيد Mistral API!');
                    notifyAdmin('⚠️ تنبيه: نفاد رصيد Mistral API (402). يرجى شحن الحساب على console.mistral.ai');
                    throw new Error('QUOTA_ERROR');
                }

                // أخطاء السيرفر (5xx) — يستحق retry
                if (response.status >= 500) {
                    lastError = new Error(`SERVER_ERROR_${response.status}`);
                    console.warn(`[Mistral] خطأ سيرفر ${response.status}، محاولة ${attempt + 1}/${retries + 1}`);
                    if (attempt < retries) {
                        const wait = 2000 * (attempt + 1);
                        await new Promise(r => setTimeout(r, wait));
                        continue;
                    }
                    throw lastError;
                }

                if (!response.ok) {
                    lastError = new Error(`HTTP_${response.status}`);
                    throw lastError;
                }

                const data = await response.json();
                if (!data?.choices?.[0]?.message?.content) {
                    lastError = new Error('استجابة فارغة من API');
                    throw lastError;
                }

                return data.choices[0].message.content;

            } catch (e) {
                // لا نعيد المحاولة على أخطاء المصادقة والرصيد
                if (e.message === 'AUTH_ERROR' || e.message === 'QUOTA_ERROR') throw e;

                lastError = e;
                if (attempt === retries) break; // اخرج من الحلقة وارمِ lastError

                const isTimeout = e.name === 'AbortError';
                const wait = isTimeout ? 1000 : 1500 * (attempt + 1);
                console.warn(`[Mistral] محاولة ${attempt + 1}/${retries + 1} فشلت (${e.message})، انتظار ${wait/1000}ث...`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
        // وصلنا هنا = فشلت كل المحاولات
        throw lastError;
    } finally {
        release();
    }
}

// كشف الأسئلة المعقدة التي تحتاج نموذج أقوى
function isComplexQuery(text) {
    return /تشخيص|خطة علاج|تحليل مفصل|اشرح بالتفصيل|قارن بين|ما الفرق بين|برمج|اكتب كود|code|برنامج|خوارزمية|قانون|عقد|فتوى|حكم شرعي|ترجم هذا النص|essay|مقال|تقرير|بحث|summarize|خلاصة شاملة/i
        .test(text || '');
}

// askAI: نموذج سريع للمحادثات العادية، قوي للأسئلة المعقدة
async function askAI(messages) {
    // آخر رسالة من المستخدم لتحديد النموذج المناسب
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const useLarge = isComplexQuery(lastUserMsg) || lastUserMsg.length > 400;
    const model = useLarge ? 'mistral-large-latest' : 'mistral-small-latest';

    console.log(`[askAI] نموذج: ${model} | طول الرسالة: ${lastUserMsg.length}`);
    try {
        return await callMistral({
            model,
            messages,
            max_tokens: 1500,
            temperature: 0.5
        });
    } catch (e) {
        // إذا فشل الصغير، جرّب الكبير تلقائياً
        if (model === 'mistral-small-latest') {
            console.warn('[askAI] small فشل، محاولة large...');
            try {
                return await callMistral({
                    model: 'mistral-large-latest',
                    messages,
                    max_tokens: 1500,
                    temperature: 0.5
                });
            } catch (e2) {
                console.error('[askAI] large فشل أيضاً:', e2.message);
                if (e2.name === 'AbortError') return 'الرد يأخذ وقتاً أطول من المعتاد، يرجى إعادة المحاولة.';
                if (e2.message === 'AUTH_ERROR') return 'عذراً، حدثت مشكلة في إعدادات الخدمة. تم إشعار الأدمن.';
                if (e2.message === 'QUOTA_ERROR') return 'عذراً، نفاد رصيد الخدمة مؤقتاً. تم إشعار الأدمن.';
                return 'عذراً، تعذّر الرد الآن. يرجى المحاولة مرة أخرى.';
            }
        }
        console.error('[askAI] فشل نهائي:', e.message);
        if (e.name === 'AbortError') return 'الرد يأخذ وقتاً أطول من المعتاد، يرجى إعادة المحاولة.';
        if (e.message === 'AUTH_ERROR') return 'عذراً، حدثت مشكلة في إعدادات الخدمة. تم إشعار الأدمن.';
        if (e.message === 'QUOTA_ERROR') return 'عذراً، نفاد رصيد الخدمة مؤقتاً. تم إشعار الأدمن.';
        return 'عذراً، تعذّر الرد الآن. يرجى المحاولة مرة أخرى.';
    }
}

async function askAIWithDoc(docText, userQuestion, userName) {
    try {
        const question = userQuestion || 'لخّص هذا الملف بشكل شامل واذكر أهم نقاطه ومحتواه';
        const prompt = userName ? `اسم المستخدم: ${userName}\n${question}` : question;
        return await callMistral({
            model: 'mistral-large-latest',   // نص فقط — لا حاجة لـ pixtral
            messages: [
                { role: 'system', content: getSystemPrompt() },
                {
                    role: 'user',
                    content: `${prompt}\n\n--- محتوى ملف PDF ---\n${docText.slice(0, 14000)}`
                }
            ],
            max_tokens: 2500,
            temperature: 0.3
        });
    } catch (e) {
        console.error('[askAIWithDoc]', e.message);
        if (e.name === 'AbortError') return 'انتهت مهلة تحليل الملف، يرجى المحاولة مرة أخرى.';
        if (e.message === 'AUTH_ERROR' || e.message === 'QUOTA_ERROR') return 'عذراً، حدثت مشكلة في إعدادات الخدمة. تم إشعار الأدمن.';
        return 'عذراً، لم أتمكن من تحليل الملف. يرجى المحاولة مرة أخرى.';
    }
}

function isMedicalImage(text) {
    return /أشعة|xray|x-ray|mri|رنين|ct scan|تحليل دم|فحص دم|صورة طبية|تقرير طبي|مختبر|مخبر|lab|blood test|صورة صدر|قلب|كلية|كبد|دماغ|brain|lung|kidney|liver|heart|ultrasound|سونار|إيكو|echo|ecg|ekg|نتائج|results|تقرير|فحص/i
        .test(text || '');
}

async function askAIWithImage(base64Image, userQuestion, userName, mimeType) {
    try {
        const mime = mimeType || 'image/jpeg';
        const hasQuestion = userQuestion && userQuestion.trim().length > 0;

        // السيستم برومت العام — يقبل أي صورة بدون قيود
        const systemToUse = getSystemPrompt();

        // إذا ما في سؤال: وصف عام شامل
        const questionText = hasQuestion
            ? userQuestion
            : `حلل هذه الصورة بالتفصيل الكامل:
1. اشرح ما تراه في الصورة بدقة
2. إذا فيها نصوص أو أرقام: اقرأها كاملاً كما هي
3. إذا فيها جدول أو بيانات: اعرضها منظمة
4. إذا كانت صورة طبية أو أشعة: حللها طبياً بالتفصيل
5. أجب على أي سؤال يتعلق بمحتوى الصورة`;

        const prompt = userName ? `اسم المستخدم: ${userName}\n${questionText}` : questionText;

        return await callMistral({
            model: 'pixtral-large-latest',
            messages: [
                { role: 'system', content: systemToUse },
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64Image}` } },
                        { type: 'text', text: prompt }
                    ]
                }
            ],
            max_tokens: 2500,
            temperature: 0.3
        });

    } catch (e) {
        console.error('[askAIWithImage]', e.message);
        if (e.name === 'AbortError') return 'انتهت مهلة التحليل، يرجى المحاولة مرة أخرى.';
        if (e.message === 'AUTH_ERROR' || e.message === 'QUOTA_ERROR') return 'عذراً، حدثت مشكلة في إعدادات الخدمة. تم إشعار الأدمن.';
        return 'عذراً، لم أتمكن من تحليل الصورة. يرجى المحاولة مرة أخرى.';
    }
}

// ============================================================
// VOXTRAL (Mistral) — تحويل الصوت إلى نص والرد عليه
// ============================================================
async function transcribeAndReplyAudio(buffer, mimeType, userQuestion, userName, chatHistory) {
    // نحوّل الصوت لـ base64
    const audioBase64 = buffer.toString('base64');

    // نبني محتوى الرسالة: صوت + سؤال (إن وُجد)
    const userContent = [
        {
            type: 'input_audio',
            input_audio: audioBase64   // base64 مباشرة بدون data URI
        }
    ];

    // إذا أرسل المستخدم نصاً مع الصوت نضيفه
    if (userQuestion && userQuestion.trim()) {
        userContent.push({ type: 'text', text: userQuestion.trim() });
    } else {
        userContent.push({
            type: 'text',
            text: userName
                ? `اسم المستخدم: ${userName}\nاستمع لهذه الرسالة الصوتية، افهمها وأجب عليها بشكل مفيد ومختصر.`
                : 'استمع لهذه الرسالة الصوتية، افهمها وأجب عليها بشكل مفيد ومختصر.'
        });
    }

    // نبني messages: system + سياق محدود + رسالة الصوت
    const messages = [
        { role: 'system', content: getSystemPrompt() },
        // آخر 6 رسائل من السياق للتواصل الطبيعي
        ...(chatHistory || []).slice(-6),
        { role: 'user', content: userContent }
    ];

    const release = await aiSemaphore();
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
                    model: 'voxtral-small-2507',   // النموذج الأقوى للصوت
                    messages,
                    max_tokens: 1000,
                    temperature: 0.5
                })
            },
            60_000
        );

        if (response.status === 429) throw new Error('RATE_LIMIT');
        if (response.status === 401) throw new Error('AUTH_ERROR');
        if (response.status === 402) throw new Error('QUOTA_ERROR');
        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`Voxtral HTTP ${response.status}: ${errBody.slice(0, 120)}`);
        }

        const data = await response.json();
        const reply = data?.choices?.[0]?.message?.content;
        if (!reply) throw new Error('استجابة فارغة من Voxtral');
        return reply;

    } finally {
        release();
    }
}

// ============================================================
// USER COMMANDS — أوامر المستخدم
// ============================================================
// يُعيد true إذا تمت معالجة الأمر (ويجب التوقف عن المعالجة الاعتيادية)
async function handleUserCommand(body, sender, reply, react, isAdmin, isVIP) {
    const cmd = (body || '').trim();
    if (!cmd.startsWith('!')) return false;

    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();

    // !مساعدة — قائمة الأوامر
    if (command === '!مساعدة' || command === '!help') {
        await reply(
            `📋 *قائمة الأوامر المتاحة:*\n\n` +
            `• *!مساعدة* — عرض هذه القائمة\n` +
            `• *!مسح* — مسح سياق المحادثة والبدء من جديد\n` +
            `• *!رصيد* — عرض عدد الرسائل المتبقية اليوم\n` +
            `• *!لغة en* — تغيير لغة الردود (ar/en/fr/...)\n` +
            `• *!ملخص* — تلخيص المحادثة الحالية\n\n` +
            `_يمكنك أيضاً إرسال صور أو ملفات PDF للتحليل_\n` +
            `_لطلب نطق كلمة أو جملة: اكتب "نطق [الكلمة]"_\n` +
            `_لطلب ترجمة: اكتب "ترجم [النص]" وسأرسل لك الصوت تلقائياً_`
        );
        return true;
    }

    // !مسح — مسح سياق المحادثة
    if (command === '!مسح' || command === '!reset') {
        userChats[sender] = [];
        await react('✅');
        await reply(`🗑️ تم مسح سياق المحادثة. يمكنك البدء من جديد! 👋`);
        return true;
    }

    // !رصيد — عرض الرصيد المتبقي
    if (command === '!رصيد' || command === '!balance') {
        if (isAdmin || isVIP) {
            await reply('♾️ *رصيدك غير محدود* (VIP/أدمن)');
        } else {
            const limit = getUserDailyLimit(sender);
            const rec   = getDailyRecord(sender);
            const used  = rec.messages;
            const remaining = Math.max(0, limit - used);
            const ttsUsed = rec.tts || 0;
            const imgUsed = rec.images || 0;
            const resetDate = new Date(rec.resetAt);
            const resetStr  = resetDate.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
            await reply(
                `📊 *رصيدك اليومي:*\n\n` +
                `💬 الرسائل: ${used}/${limit} (متبقي: ${remaining})\n` +
                `🖼️ الصور: ${imgUsed}/${DAILY_IMG_LIMIT} (متبقي: ${Math.max(0, DAILY_IMG_LIMIT - imgUsed)})\n` +
                `🔊 الصوت/الترجمة: ${ttsUsed}/${DAILY_TTS_LIMIT} (متبقي: ${Math.max(0, DAILY_TTS_LIMIT - ttsUsed)})\n` +
                `🔄 يتجدد عند: ${resetStr}\n\n` +
                `_للاشتراك المميز (غير محدود) تواصل مع المهندس نادر_\n` +
                `👤 wa.me/972593850520`
            );
        }
        return true;
    }

    // !لغة — تغيير اللغة
    if (command === '!لغة' || command === '!language' || command === '!lang') {
        const lang = parts[1] || '';
        if (!lang) {
            const currentLang = userLanguages[sender] || 'ar (افتراضي)';
            await reply(`🌐 لغتك الحالية: *${currentLang}*\n\nمثال لتغييرها:\n• !لغة en (إنجليزي)\n• !لغة ar (عربي)\n• !لغة fr (فرنسي)`);
        } else {
            userLanguages[sender] = lang.toLowerCase();
            saveData();
            const langNames = { ar: 'العربية', en: 'الإنجليزية', fr: 'الفرنسية', de: 'الألمانية', es: 'الإسبانية', tr: 'التركية' };
            const langName = langNames[lang.toLowerCase()] || lang;
            await react('✅');
            await reply(`🌐 تم تغيير اللغة إلى: *${langName}*\nسأرد عليك بهذه اللغة من الآن.`);
        }
        return true;
    }

    // !ملخص — تلخيص المحادثة الحالية
    if (command === '!ملخص' || command === '!summary') {
        const history = userChats[sender] || [];
        const convMsgs = history;
        if (convMsgs.length < 2) {
            await reply('📝 لا يوجد محادثة كافية للتلخيص بعد. تحدث أكثر ثم جرب الأمر مجدداً!');
            return true;
        }
        await react('⏳');
        const convText = convMsgs.slice(-20).map(m =>
            `${m.role === 'user' ? 'المستخدم' : 'البوت'}: ${m.content.slice(0, 300)}`
        ).join('\n');
        try {
            const summary = await callMistral({
                model: 'mistral-small-latest',
                messages: [
                    { role: 'system', content: 'لخّص هذه المحادثة بشكل مختصر ومنظم في 5-7 نقاط. ركّز على المحاور الرئيسية.' },
                    { role: 'user', content: convText }
                ],
                max_tokens: 600,
                temperature: 0.3
            });
            await reply(`📝 *ملخص المحادثة:*\n\n${summary}`);
            await react('✅');
        } catch (e) {
            await reply('عذراً، حدث خطأ أثناء التلخيص. حاول مرة أخرى.');
            await react('❌');
        }
        return true;
    }

    return false; // لم يُعرَّف الأمر
}


// كل مستخدم رسالة عشوائية مختلفة + rate limiting ذكي
async function broadcastToAll(getTextFn) {
    const allUsers = Object.keys(welcomedUsers)
        .map(n => cleanNumber(n))
        .filter(n => n && n !== ADMIN_NUMBER && /^\d+$/.test(n));

    console.log(`📢 قائمة البث: ${allUsers.length} مستخدم`);
    let sent = 0, failed = 0;

    for (let i = 0; i < allUsers.length; i++) {
        const num = allUsers[i];

        if (i > 0 && i % 30 === 0) {
            console.log(`⏸️ استراحة 10 ثواني بعد ${i} رسائل...`);
            await new Promise(r => setTimeout(r, 10_000));
        }

        try {
            const text = typeof getTextFn === 'function' ? getTextFn() : getTextFn;
            const jid = `${num}@s.whatsapp.net`;
            console.log(`📤 إرسال لـ ${num}`);
            await sock.sendMessage(jid, { text });
            sent++;
            console.log(`✅ وصل لـ ${num}`);
        } catch(e) {
            console.error(`❌ فشل لـ ${num}:`, e.message);
            failed++;
        }

        await new Promise(r => setTimeout(r, 800));
    }

    console.log(`📢 اكتمل البث: ${sent} نجح، ${failed} فشل`);
    return { sent, failed, total: allUsers.length };
}


// ============================================================
// QR WEB SERVER
// ============================================================
function startQRServer() {
    const _webRateLimit = {}; // IP-based rate limit للـ web server
    function checkWebRate(ip) {
        const now = Date.now();
        if (!_webRateLimit[ip]) _webRateLimit[ip] = { count: 0, first: now };
        const s = _webRateLimit[ip];
        if (now - s.first > 60_000) { s.count = 0; s.first = now; }
        s.count++;
        return s.count <= 60; // 60 request/دقيقة لكل IP
    }
    setInterval(() => {
        const now = Date.now();
        for (const ip of Object.keys(_webRateLimit))
            if (now - _webRateLimit[ip].first > 120_000) delete _webRateLimit[ip];
    }, 5 * 60_000);

    // صفحة تسجيل الدخول
    function loginPage(errMsg) {
        return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BOT_NAME} — تسجيل الدخول</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0b0f1a;--surface:#111827;--border:#1e2d45;--text:#e2e8f0;--muted:#64748b;--accent:#38bdf8;--red:#f87171;--green:#22c55e}
body{font-family:'Segoe UI',system-ui,Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:40px 36px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.logo{display:flex;align-items:center;gap:12px;margin-bottom:32px;justify-content:center}
.logo-icon{width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,#0ea5e9,#6366f1);display:flex;align-items:center;justify-content:center;font-size:24px}
.logo-name{font-size:22px;font-weight:800;color:var(--accent)}
h2{font-size:16px;color:var(--muted);text-align:center;margin-bottom:28px;font-weight:400}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px;margin-top:16px}
input{width:100%;background:#0b0f1a;border:1px solid var(--border);border-radius:10px;padding:11px 14px;color:var(--text);font-size:14px;outline:none;transition:.2s}
input:focus{border-color:var(--accent)}
.err{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.3);border-radius:8px;padding:10px 14px;color:var(--red);font-size:13px;margin-top:14px;display:${errMsg ? 'block' : 'none'}}
button{width:100%;margin-top:24px;background:linear-gradient(135deg,#0ea5e9,#6366f1);border:none;border-radius:10px;padding:13px;color:#fff;font-size:15px;font-weight:700;cursor:pointer;transition:.2s}
button:hover{opacity:.9;transform:translateY(-1px)}
.footer{text-align:center;margin-top:20px;font-size:11px;color:var(--muted)}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-icon">🏥</div>
    <span class="logo-name">${BOT_NAME}</span>
  </div>
  <h2>لوحة تحكم الأدمن</h2>
  <form method="POST" action="/login">
    <label>اسم المستخدم</label>
    <input type="text" name="username" placeholder="أدخل اسم المستخدم" autocomplete="off" required>
    <label>كلمة السر</label>
    <input type="password" name="password" placeholder="أدخل كلمة السر" required>
    <div class="err">${errMsg || ''}</div>
    <button type="submit">🔐 دخول</button>
  </form>
  <div class="footer">${BOT_NAME} Admin Panel &copy; 2025</div>
</div>
</body>
</html>`;
    }

    const server = http.createServer(async (req, res) => {
        res.setHeader('Connection', 'close');
        const ip  = req.socket.remoteAddress || 'unknown';
        const url = req.url.split('?')[0];

        if (!checkWebRate(ip)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Too many requests' }));
            return;
        }

        // ===== LOGIN PAGE (GET) =====
        if (url === '/login' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(loginPage(''));
            return;
        }

        // ===== LOGIN SUBMIT (POST) =====
        if (url === '/login' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', () => {
                try {
                    const params = Object.fromEntries(
                        body.split('&').map(p => p.split('=').map(v => decodeURIComponent(v.replace(/\+/g, ' '))))
                    );
                    if (params.username === DASHBOARD_USER && params.password === DASHBOARD_PASS) {
                        const token = generateToken();
                        _sessions[token] = { ip, createdAt: Date.now() };
                        res.writeHead(302, {
                            'Set-Cookie': `adm_tok=${token}; Path=/; HttpOnly; Max-Age=43200; SameSite=Strict`,
                            'Location': '/'
                        });
                        res.end();
                    } else {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        res.end(loginPage('❌ اسم المستخدم أو كلمة السر غير صحيحة'));
                    }
                } catch (e) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(loginPage('حدث خطأ، حاول مرة أخرى'));
                }
            });
            return;
        }

        // ===== LOGOUT =====
        if (url === '/logout') {
            const token = parseCookie(req.headers['cookie'] || '')['adm_tok'];
            if (token) delete _sessions[token];
            res.writeHead(302, {
                'Set-Cookie': 'adm_tok=; Path=/; Max-Age=0',
                'Location': '/login'
            });
            res.end();
            return;
        }

        // ===== حماية كل الـ endpoints — إعادة توجيه لصفحة الدخول =====
        if (!isValidSession(req)) {
            if (url === '/api' || url === '/data' || url === '/qr-image') {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, msg: 'Unauthorized' }));
            } else {
                res.writeHead(302, { 'Location': '/login' });
                res.end();
            }
            return;
        }

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
                        if (num && !vipNumbers.includes(num)) {
                            vipNumbers.push(num);
                            // تاريخ الانتهاء: شهر من الآن
                            const expiry = Date.now() + 30 * 24 * 60 * 60_000;
                            vipExpiry[num] = expiry;
                            saveData();
                            // إشعار المستخدم
                            if (sock && isConnected) {
                                try {
                                    const expDate = new Date(expiry).toLocaleDateString('ar-SA');
                                    await sock.sendMessage(`${num}@s.whatsapp.net`, {
                                        text: `🎉 *تهانينا! تم تفعيل اشتراكك المميز (VIP)*\n\n✅ صلاحياتك الآن:\n• رسائل غير محدودة\n• صور غير محدودة\n• صوت وترجمة غير محدودة\n\n📅 تاريخ الانتهاء: ${expDate}\n\nشكراً لاشتراكك! 🌟`
                                    });
                                } catch (_) {}
                            }
                            result.msg = `تم تفعيل VIP للمستخدم ${num} لمدة شهر`;
                        } else if (vipNumbers.includes(num)) {
                            // تجديد الاشتراك — إضافة شهر من الآن
                            const current = vipExpiry[num] || Date.now();
                            vipExpiry[num] = Math.max(current, Date.now()) + 30 * 24 * 60 * 60_000;
                            saveData();
                            result.msg = `تم تجديد VIP للمستخدم ${num} لشهر إضافي`;
                        }
                    }
                    else if (action === 'removeVip') {
                        const num = (data.num || '').replace(/\D/g, '');
                        vipNumbers = vipNumbers.filter(n => n !== num);
                        delete vipExpiry[num];
                        saveData();
                        // إشعار المستخدم
                        if (num && sock && isConnected) {
                            try {
                                await sock.sendMessage(`${num}@s.whatsapp.net`, {
                                    text: `ℹ️ تم إلغاء اشتراكك المميز (VIP).\nيمكنك التجديد عبر التواصل مع المهندس نادر:\n👤 wa.me/972593850520`
                                });
                            } catch (_) {}
                        }
                        result.msg = 'تم إزالة VIP';
                    }
                    else if (action === 'deleteUser') {
                        const num = data.num;
                        delete userChats[num];
                        delete welcomedUsers[num];
                        delete userNames[num];
                        vipNumbers = vipNumbers.filter(n => n !== num);
                        reports = reports.filter(r => r.sender !== num);
                        saveData();
                    }
                    else if (action === 'clearReports') {
                        reports = [];
                        saveData();
                    }
                    else if (action === 'addBlacklist') {
                        const num = (data.num || '').replace(/\D/g, '');
                        if (num && !blacklist.includes(num)) {
                            blacklist.push(num);
                            saveData();
                            // إشعار المحظور تلقائياً
                            if (sock && isConnected) {
                                try {
                                    await sock.sendMessage(`${num}@s.whatsapp.net`, { text: BLACKLIST_MSG });
                                } catch (_) {}
                            }
                        }
                    }
                    else if (action === 'removeBlacklist') {
                        const num = (data.num || '').replace(/\D/g, '');
                        blacklist = blacklist.filter(n => n !== num);
                        saveData();
                        result.msg = 'تم رفع الحظر';
                    }
                    else if (action === 'clearSessions') {
                        userChats = {};
                        result.msg = 'تم مسح الجلسات';
                    }
                    else if (action === 'setUserLimit') {
                        // تعيين حد مخصص لمستخدم: { num, limit }
                        const num   = (data.num || '').replace(/\D/g, '');
                        const limit = parseInt(data.limit, 10);
                        if (!num || isNaN(limit) || limit < 0) {
                            result = { ok: false, msg: 'بيانات غير صحيحة' };
                        } else {
                            const oldLimit = getUserDailyLimit(num);
                            userLimits[num] = limit;

                            // إذا كان المستخدم متجاوزاً وتم رفع الحد عن استهلاكه الحالي
                            // → نصفّر العداد لمستواه الحالي حتى يستطيع الإرسال فوراً
                            const rec = getDailyRecord(num);
                            const alreadyUsed = rec ? rec.messages : 0;
                            if (limit > oldLimit && alreadyUsed >= oldLimit && alreadyUsed < limit) {
                                // لا نمسح الاستخدام — فقط نتركه كما هو لأن الحد الجديد أعلى منه
                            } else if (limit > alreadyUsed && alreadyUsed >= oldLimit) {
                                // المستخدم كان محظور الإرسال — الحد الجديد يسمح له: لا حاجة لتعديل
                            }
                            // إذا رُفع الحد فوق الاستهلاك الحالي يُسمح للمستخدم تلقائياً (لأن checkDailyMessages تقارن rec.messages < limit)

                            saveData();
                            // إشعار المستخدم فقط إذا رُفع الحد (ليس عند التخفيض)
                            const nowAllowed = alreadyUsed < limit;
                            if (sock && isConnected && limit > oldLimit) {
                                try {
                                    const jid = `${num}@s.whatsapp.net`;
                                    const name = userNames[num] ? `${userNames[num]}` : '';
                                    const msg = nowAllowed
                                        ? `🎉 ${name ? `أهلاً ${name}، ` : ''}تم رفع حد رسائلك اليومي إلى *${limit}* رسالة!\n\nيمكنك الآن الاستمرار في المحادثة. 🚀`
                                        : `ℹ️ ${name ? `${name}، ` : ''}تم تعديل حدك اليومي إلى *${limit}* رسالة.\n\nسيتجدد رصيدك في منتصف الليل 🔄`;
                                    await sock.sendMessage(jid, { text: msg });
                                } catch (e) {
                                    console.error('[setUserLimit notify]', e.message);
                                }
                            }
                            result.msg = `تم تعيين حد ${limit} رسالة للمستخدم ${num}`;
                        }
                    }
                    else if (action === 'resetUserLimit') {
                        // إعادة المستخدم للحد الافتراضي — العداد الحالي يبقى كما هو
                        const num = (data.num || '').replace(/\D/g, '');
                        if (num) {
                            delete userLimits[num];
                            // لا نصفّر العداد — المستخدم المتجاوز يبقى متجاوزاً حتى منتصف الليل
                            saveData();
                        }
                        result.msg = 'تم إعادة الحد للافتراضي';
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
            // بناء بيانات الاستهلاك لكل مستخدم
            const userUsage = {};
            for (const num of Object.keys(welcomedUsers)) {
                const cleanNum = cleanNumber(num);
                const rec = _userDailyLimit[cleanNum];
                const limit = getUserDailyLimit(cleanNum);
                userUsage[cleanNum] = {
                    used: rec ? rec.messages : 0,
                    images: rec ? rec.images : 0,
                    docs: rec ? rec.docs : 0,
                    limit,
                    remaining: Math.max(0, limit - (rec ? rec.messages : 0)),
                    resetAt: rec ? rec.resetAt : null
                };
            }
            const d = {
                connected: isConnected,
                hasQR: !!currentQR,
                botName: BOT_NAME,
                defaultLimit: DAILY_MSG_LIMIT,
                stats: {
                    users: Object.keys(welcomedUsers).length,
                    active: Object.keys(userChats).length,
                    vip: vipNumbers.length,
                    messages: stats.totalMessages || 0,
                    images: stats.totalImages || 0,
                    docs: stats.totalDocs || 0,
                    medical: stats.totalMedical || 0,
                    reports: reports.length
                },
                vipNumbers,
                vipExpiry,
                userLimits,
                userNames,
                userUsage,
                blacklist: blacklist || [],
                welcomedUsers: Object.keys(welcomedUsers).map(n => cleanNumber(n)).filter(Boolean),
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
<title>${BOT_NAME} — لوحة التحكم</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0b0f1a;--surface:#111827;--surface2:#1a2235;--border:#1e2d45;
  --text:#e2e8f0;--muted:#64748b;--accent:#38bdf8;--accent2:#818cf8;
  --green:#22c55e;--red:#f87171;--yellow:#fbbf24;--purple:#a78bfa;--orange:#fb923c;
}
body{font-family:'Segoe UI',system-ui,Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}

/* ── SIDEBAR ── */
.sidebar{position:fixed;top:0;right:0;height:100vh;width:220px;background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;z-index:200;transition:.3s}
.sidebar-logo{padding:20px 16px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}
.sidebar-logo .bot-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#6366f1);display:flex;align-items:center;justify-content:center;font-size:18px}
.sidebar-logo .bot-name{font-size:15px;font-weight:700;color:var(--accent)}
.sidebar-logo .bot-status{font-size:10px;color:var(--muted);margin-top:2px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);display:inline-block;vertical-align:middle;transition:.3s}
.dot.on{background:var(--green);box-shadow:0 0 6px var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.nav{flex:1;padding:12px 8px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:9px;cursor:pointer;font-size:13px;color:var(--muted);transition:.2s;user-select:none}
.nav-item:hover{background:var(--surface2);color:var(--text)}
.nav-item.active{background:rgba(56,189,248,.12);color:var(--accent);font-weight:600}
.nav-item .icon{font-size:16px;width:20px;text-align:center}
.nav-badge{margin-right:auto;background:var(--red);color:#fff;border-radius:99px;font-size:10px;font-weight:700;padding:1px 6px;min-width:18px;text-align:center}
.sidebar-footer{padding:12px 16px;border-top:1px solid var(--border);font-size:11px;color:var(--muted)}
.sidebar-footer strong{color:var(--text)}

/* ── MAIN ── */
.main{margin-right:220px;min-height:100vh;display:flex;flex-direction:column}
.topbar{padding:14px 24px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.topbar-left{display:flex;align-items:center;gap:12px}
.topbar-title{font-size:16px;font-weight:700;color:var(--text)}
.topbar-sub{font-size:12px;color:var(--muted)}
.topbar-right{display:flex;align-items:center;gap:10px}
.refresh-btn{background:var(--surface2);border:1px solid var(--border);color:var(--muted);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;transition:.2s}
.refresh-btn:hover{color:var(--accent);border-color:var(--accent)}
.logout-btn{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.25);color:var(--red);padding:6px 14px;border-radius:8px;cursor:pointer;font-size:12px;transition:.2s;text-decoration:none}
.logout-btn:hover{background:rgba(248,113,113,.22)}
#last-updated{font-size:11px;color:var(--muted)}

/* ── CONTENT ── */
.content{padding:20px 24px;flex:1}
.panel{display:none}.panel.active{display:block;animation:fadeIn .2s}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

/* ── STATS GRID ── */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px;position:relative;overflow:hidden;transition:.2s}
.stat-card::before{content:'';position:absolute;top:-20px;right:-20px;width:70px;height:70px;border-radius:50%;opacity:.08}
.stat-card.blue::before{background:var(--accent)}
.stat-card.green::before{background:var(--green)}
.stat-card.yellow::before{background:var(--yellow)}
.stat-card.red::before{background:var(--red)}
.stat-card.purple::before{background:var(--purple)}
.stat-card.orange::before{background:var(--orange)}
.stat-val{font-size:30px;font-weight:800;line-height:1}
.stat-card.blue .stat-val{color:var(--accent)}
.stat-card.green .stat-val{color:var(--green)}
.stat-card.yellow .stat-val{color:var(--yellow)}
.stat-card.red .stat-val{color:var(--red)}
.stat-card.purple .stat-val{color:var(--purple)}
.stat-card.orange .stat-val{color:var(--orange)}
.stat-label{font-size:11px;color:var(--muted);margin-top:6px}

/* ── CARDS ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;margin-bottom:16px}
.card-header{padding:14px 18px;background:rgba(0,0,0,.25);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.card-title{font-size:13px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px}
.card-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}

/* ── TABLE ── */
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{padding:9px 14px;text-align:right;font-size:11px;color:var(--muted);background:rgba(0,0,0,.2);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:10px 14px;font-size:12px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(56,189,248,.03)}
.empty{text-align:center;color:var(--muted);padding:30px;font-size:13px}

/* ── BUTTONS ── */
.btn{border:none;padding:5px 11px;border-radius:7px;cursor:pointer;font-size:11px;font-weight:700;transition:.15s;white-space:nowrap}
.btn:hover{filter:brightness(1.15)}
.btn-primary{background:var(--accent);color:#0f172a}
.btn-success{background:var(--green);color:#0f172a}
.btn-danger{background:#dc2626;color:#fff}
.btn-warn{background:var(--yellow);color:#0f172a}
.btn-purple{background:#7c3aed;color:#fff}
.btn-ghost{background:var(--surface2);border:1px solid var(--border);color:var(--muted)}
.btn-ghost:hover{color:var(--accent);border-color:var(--accent)}

/* ── INPUTS ── */
.inp{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:9px;font-size:12px;transition:.2s;font-family:inherit}
.inp:focus{outline:none;border-color:var(--accent);background:rgba(56,189,248,.05)}
.inp::placeholder{color:var(--muted)}
textarea.inp{resize:vertical;min-height:90px;width:100%}

/* ── BADGES ── */
.badge{padding:2px 9px;border-radius:99px;font-size:10px;font-weight:700;white-space:nowrap}
.badge-green{background:rgba(34,197,94,.15);color:var(--green)}
.badge-red{background:rgba(248,113,113,.15);color:var(--red)}
.badge-blue{background:rgba(56,189,248,.15);color:var(--accent)}
.badge-yellow{background:rgba(251,191,36,.15);color:var(--yellow)}
.badge-purple{background:rgba(167,139,250,.15);color:var(--purple)}
.badge-muted{background:rgba(100,116,139,.15);color:var(--muted)}

/* ── PROGRESS BAR ── */
.prog-wrap{display:flex;align-items:center;gap:8px}
.prog-bar{flex:1;height:5px;background:var(--border);border-radius:99px;overflow:hidden;min-width:60px}
.prog-fill{height:100%;border-radius:99px;transition:.3s}
.prog-fill.low{background:var(--green)}
.prog-fill.mid{background:var(--yellow)}
.prog-fill.high{background:var(--red)}
.prog-text{font-size:11px;color:var(--muted);white-space:nowrap;min-width:50px;text-align:left}

/* ── TOAST ── */
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 22px;border-radius:12px;font-size:13px;opacity:0;transition:.3s;pointer-events:none;z-index:9999;font-weight:600;box-shadow:0 8px 32px rgba(0,0,0,.4)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(-4px)}

/* ── QR ── */
.qr-wrap{display:flex;flex-direction:column;align-items:center;gap:20px;padding:32px}
.qr-wrap img{border-radius:16px;width:260px;border:4px solid var(--border)}
.qr-steps{background:var(--surface2);border-radius:12px;padding:16px 20px;font-size:13px;color:var(--muted);line-height:2.2;text-align:right;width:100%;max-width:340px}
.qr-steps span{color:var(--accent);font-weight:700}
.connected-msg{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:var(--green);padding:16px 28px;border-radius:14px;font-size:16px;font-weight:700;text-align:center}

/* ── SEARCH BAR ── */
.search-inp{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:7px 12px;border-radius:8px;font-size:12px;width:200px}
.search-inp:focus{outline:none;border-color:var(--accent)}

/* ── FORM ROW ── */
.form-row{display:flex;gap:8px;padding:14px 18px;background:rgba(0,0,0,.2);border-top:1px solid var(--border);flex-wrap:wrap;align-items:center}
.form-row label{font-size:12px;color:var(--muted)}

/* ── ACTION ROW ── */
.action-row{display:flex;gap:6px;flex-wrap:wrap}

/* ── QUICK ACTIONS ── */
.quick-actions{display:flex;gap:10px;flex-wrap:wrap;padding:16px 18px}

/* ── RESPONSIVE ── */
@media(max-width:760px){
  .sidebar{width:100%;height:auto;position:relative;border-left:none;border-bottom:1px solid var(--border)}
  .nav{flex-direction:row;flex-wrap:wrap;padding:8px}
  .nav-item{padding:6px 10px;font-size:12px}
  .main{margin-right:0}
  .stats-grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}
}

/* ── INFO BOX ── */
.info-box{background:rgba(56,189,248,.07);border:1px solid rgba(56,189,248,.2);border-radius:10px;padding:10px 14px;font-size:12px;color:var(--muted)}
.info-box strong{color:var(--accent)}

/* ── SECTION LABEL ── */
.section-label{font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;margin-top:4px;padding-right:4px}
</style>
</head>
<body>

<!-- SIDEBAR -->
<div class="sidebar">
  <div class="sidebar-logo">
    <div class="bot-icon">🤖</div>
    <div>
      <div class="bot-name">${BOT_NAME}</div>
      <div class="bot-status"><span class="dot" id="dot"></span> <span id="conn-label">جاري التحقق...</span></div>
    </div>
  </div>
  <nav class="nav">
    <div class="nav-item active" data-tab="overview" onclick="showTab('overview')"><span class="icon">📊</span> نظرة عامة</div>
    <div class="nav-item" data-tab="qr" onclick="showTab('qr')"><span class="icon">📱</span> ربط واتساب</div>
    <div class="nav-item" data-tab="users" onclick="showTab('users')"><span class="icon">👥</span> المستخدمون</div>
    <div class="nav-item" data-tab="usage" onclick="showTab('usage')"><span class="icon">📈</span> الاستهلاك</div>
    <div class="nav-item" data-tab="limits" onclick="showTab('limits')"><span class="icon">🔢</span> حدود الرسائل</div>
    <div class="nav-item" data-tab="vip" onclick="showTab('vip')"><span class="icon">⭐</span> VIP</div>
    <div class="nav-item" data-tab="blacklist" onclick="showTab('blacklist')"><span class="icon">⛔</span> المحظورون</div>
    <div class="nav-item" data-tab="broadcast" onclick="showTab('broadcast')"><span class="icon">📢</span> البث</div>
    <div class="nav-item" data-tab="reports" onclick="showTab('reports')"><span class="icon">🚨</span> البلاغات <span class="nav-badge" id="reports-badge" style="display:none">0</span></div>
  </nav>
  <div class="sidebar-footer">
    آخر تحديث: <strong id="last-updated">—</strong>
  </div>
</div>

<!-- MAIN -->
<div class="main">
  <div class="topbar">
    <div class="topbar-left">
      <div>
        <div class="topbar-title" id="page-title">نظرة عامة</div>
        <div class="topbar-sub" id="page-sub">إحصائيات البوت الكاملة</div>
      </div>
    </div>
    <div class="topbar-right">
      <button class="refresh-btn" onclick="loadData()">🔄 تحديث</button>
      <a href="/logout" class="logout-btn">🚪 خروج</a>
    </div>
  </div>

  <div class="content">

    <!-- ══ نظرة عامة ══ -->
    <div class="panel active" id="panel-overview">
      <div class="stats-grid" id="stats-grid">
        <div class="stat-card blue"><div class="stat-val" id="s-users">—</div><div class="stat-label">👥 إجمالي المستخدمين</div></div>
        <div class="stat-card green"><div class="stat-val" id="s-active">—</div><div class="stat-label">🟢 جلسات نشطة الآن</div></div>
        <div class="stat-card yellow"><div class="stat-val" id="s-vip">—</div><div class="stat-label">⭐ أعضاء VIP</div></div>
        <div class="stat-card purple"><div class="stat-val" id="s-msgs">—</div><div class="stat-label">💬 إجمالي الرسائل</div></div>
        <div class="stat-card blue"><div class="stat-val" id="s-imgs">—</div><div class="stat-label">🖼️ الصور المحللة</div></div>
        <div class="stat-card orange"><div class="stat-val" id="s-docs">—</div><div class="stat-label">📄 ملفات PDF</div></div>
        <div class="stat-card green"><div class="stat-val" id="s-med">—</div><div class="stat-label">🏥 صور طبية</div></div>
        <div class="stat-card red"><div class="stat-val" id="s-rep">—</div><div class="stat-label">🚨 البلاغات</div></div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">⚡ إجراءات سريعة</div></div>
        <div class="quick-actions">
          <button class="btn btn-danger" onclick="doAction('clearSessions')">🗑️ مسح كل الجلسات</button>
          <button class="btn btn-warn" onclick="showTab('broadcast')">📢 إرسال بث جماعي</button>
          <button class="btn btn-primary" onclick="loadData()">🔄 تحديث البيانات</button>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">📶 حالة النظام</div></div>
        <div style="padding:16px 18px;display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
            <span style="color:var(--muted)">حالة البوت</span>
            <span id="sys-status">—</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
            <span style="color:var(--muted)">نسبة المحظورين</span>
            <span id="sys-blocked">—</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
            <span style="color:var(--muted)">الحد الافتراضي اليومي</span>
            <span id="sys-deflimit">—</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:13px">
            <span style="color:var(--muted)">نسبة VIP</span>
            <span id="sys-vippct">—</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ══ ربط واتساب ══ -->
    <div class="panel" id="panel-qr">
      <div class="card">
        <div class="card-header"><div class="card-title">📱 حالة الاتصال بواتساب</div></div>
        <div class="qr-wrap" id="qr-section">
          <div style="color:var(--muted)">جاري التحميل...</div>
        </div>
      </div>
    </div>

    <!-- ══ المستخدمون ══ -->
    <div class="panel" id="panel-users">
      <div class="card">
        <div class="card-header">
          <div class="card-title">👥 إدارة المستخدمين</div>
          <div class="card-actions">
            <input class="search-inp" id="user-search" placeholder="🔍 بحث بالرقم أو الاسم..." oninput="filterUsers()">
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead><tr>
              <th>الرقم</th><th>الاسم</th><th>الحالة</th>
              <th>الاستهلاك اليومي</th><th>الحد المخصص</th><th>الإجراءات</th>
            </tr></thead>
            <tbody id="users-table"><tr><td colspan="6" class="empty">جاري التحميل...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ══ الاستهلاك ══ -->
    <div class="panel" id="panel-usage">
      <div class="card">
        <div class="card-header">
          <div class="card-title">📈 تقرير الاستهلاك اليومي</div>
          <div class="card-actions">
            <input class="search-inp" id="usage-search" placeholder="🔍 بحث..." oninput="filterUsage()">
            <select class="search-inp" id="usage-filter" onchange="filterUsage()" style="width:130px">
              <option value="all">الكل</option>
              <option value="active">نشطون اليوم</option>
              <option value="full">وصلوا الحد</option>
              <option value="vip">VIP فقط</option>
            </select>
          </div>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead><tr>
              <th>الرقم</th><th>الاسم</th><th>الحالة</th>
              <th>رسائل مستخدمة</th><th>صور</th><th>ملفات</th>
              <th>الحد اليومي</th><th>المتبقي</th><th>نسبة الاستهلاك</th>
            </tr></thead>
            <tbody id="usage-table"><tr><td colspan="9" class="empty">جاري التحميل...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ══ حدود الرسائل ══ -->
    <div class="panel" id="panel-limits">
      <div class="card">
        <div class="card-header">
          <div class="card-title">🔢 حدود الرسائل اليومية</div>
          <span id="default-limit-label" style="font-size:12px;color:var(--muted)"></span>
        </div>
        <div class="form-row">
          <label>تعيين حد لمستخدم:</label>
          <input class="inp" id="limit-num" placeholder="رقم الهاتف" dir="ltr" style="width:170px">
          <input class="inp" id="limit-val" placeholder="عدد الرسائل" type="number" min="0" style="width:120px">
          <button class="btn btn-primary" onclick="setUserLimit()">✅ تعيين وإشعار</button>
          <button class="btn btn-danger" onclick="resetUserLimit()">↩️ إعادة للافتراضي</button>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>الرقم</th><th>الاسم</th><th>الحد المخصص</th><th>الاستخدام اليوم</th><th>إجراء</th></tr></thead>
            <tbody id="limits-table"><tr><td colspan="5" class="empty">لا يوجد حدود مخصصة</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ══ VIP ══ -->
    <div class="panel" id="panel-vip">
      <div class="card">
        <div class="card-header"><div class="card-title">⭐ أعضاء VIP (اشتراك شهري — غير محدود)</div></div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>الرقم</th><th>الاسم</th><th>ينتهي بعد</th><th>الإجراء</th></tr></thead>
            <tbody id="vip-table"><tr><td colspan="4" class="empty">جاري التحميل...</td></tr></tbody>
          </table>
        </div>
        <div class="form-row" style="margin-top:12px">
          <input class="inp" id="new-vip" placeholder="رقم الهاتف مع كود الدولة" dir="ltr" style="flex:1;min-width:200px">
          <button class="btn btn-success" onclick="addVip()">⭐ تفعيل VIP (شهر)</button>
        </div>
      </div>
    </div>

    <!-- ══ المحظورون ══ -->
    <div class="panel" id="panel-blacklist">
      <div class="card">
        <div class="card-header"><div class="card-title">⛔ قائمة المحظورين</div></div>
        <div class="form-row">
          <label>حظر مستخدم:</label>
          <input class="inp" id="bl-num" placeholder="رقم الهاتف مع كود الدولة" dir="ltr" style="width:200px">
          <button class="btn btn-danger" onclick="addBlacklist()">⛔ حظر وإشعار</button>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>الرقم</th><th>الاسم</th><th>الإجراء</th></tr></thead>
            <tbody id="blacklist-table"><tr><td colspan="3" class="empty">لا يوجد مستخدمون محظورون</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- ══ البث ══ -->
    <div class="panel" id="panel-broadcast">
      <div class="card">
        <div class="card-header"><div class="card-title">📢 إرسال رسالة جماعية لجميع المستخدمين</div></div>
        <div style="padding:18px;display:flex;flex-direction:column;gap:12px">
          <textarea class="inp" id="broadcast-text" placeholder="اكتب الرسالة هنا..."></textarea>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn btn-primary" onclick="sendBroadcast()">📢 إرسال للجميع</button>
            <span id="broadcast-count" style="font-size:12px;color:var(--muted)"></span>
          </div>
          <div class="info-box">⚠️ الرسالة ستُرسل لجميع المستخدمين مع تأخير 800ms بين كل رسالة لتجنب الحظر.</div>
        </div>
      </div>
    </div>

    <!-- ══ البلاغات ══ -->
    <div class="panel" id="panel-reports">
      <div class="card">
        <div class="card-header">
          <div class="card-title">🚨 البلاغات المستلمة</div>
          <button class="btn btn-danger" onclick="clearReports()">🗑️ مسح الكل</button>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>#</th><th>الاسم</th><th>الرقم</th><th>المشكلة</th><th>الوقت</th><th>إجراء</th></tr></thead>
            <tbody id="reports-table"><tr><td colspan="6" class="empty">جاري التحميل...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

  </div><!-- /content -->
</div><!-- /main -->

<div class="toast" id="toast"></div>

<script>
function esc(s){
  if(s==null)return'';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
}

const PAGE_META={
  overview:{title:'نظرة عامة',sub:'إحصائيات البوت الكاملة'},
  qr:{title:'ربط واتساب',sub:'امسح رمز QR لربط الجهاز'},
  users:{title:'المستخدمون',sub:'إدارة وصلاحيات كل مستخدم'},
  usage:{title:'الاستهلاك اليومي',sub:'تقرير استهلاك الرسائل والصور والملفات'},
  limits:{title:'حدود الرسائل',sub:'تخصيص الحد اليومي لكل مستخدم'},
  vip:{title:'أعضاء VIP',sub:'مستخدمون بصلاحيات غير محدودة'},
  blacklist:{title:'المحظورون',sub:'قائمة المحظورين من استخدام البوت'},
  broadcast:{title:'البث الجماعي',sub:'إرسال رسالة لجميع المستخدمين'},
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
    const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,data})});
    if(r.status===401){window.location.href='/login';return{ok:false};}
    return await r.json();
  }catch(e){toast('خطأ في الاتصال','#dc2626');return{ok:false};}
}

async function loadData(){
  try{
    const r=await fetch('/data');
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

  // QR
  const qrSec=document.getElementById('qr-section');
  if(d.connected){
    qrSec.innerHTML='<div class="connected-msg">✅ البوت متصل بواتساب وجاهز للرد!</div>';
  }else if(d.hasQR){
    qrSec.innerHTML=\`<img src="/qr-image?t=\${Date.now()}" alt="QR Code">
    <div class="qr-steps">
      <div><span>1.</span> افتح واتساب على هاتفك</div>
      <div><span>2.</span> اذهب إلى الإعدادات ← الأجهزة المرتبطة</div>
      <div><span>3.</span> اضغط "ربط جهاز"</div>
      <div><span>4.</span> امسح هذا الرمز</div>
    </div>\`;
  }else{
    qrSec.innerHTML='<div style="color:var(--muted);font-size:14px">⏳ في انتظار رمز QR... يتجدد تلقائياً.</div>';
  }

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
    usage:d.userUsage?d.userUsage[num]:null,
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
    const progHtml=\`<div class="prog-wrap"><div class="prog-bar"><div class="prog-fill \${fillClass}" style="width:\${pct}%"></div></div><div class="prog-text">\${usage.used}/\${usage.limit}</div></div>\`;
    const customLimitBadge=u.customLimit!=null?\`<span class="badge badge-yellow">\${u.customLimit}</span>\`:'<span class="badge badge-muted">افتراضي</span>';
    const statusBadge=u.isBlocked?'<span class="badge badge-red">⛔ محظور</span>':u.isVip?'<span class="badge badge-blue">⭐ VIP</span>':'<span class="badge badge-green">عادي</span>';
    const vipBtn=u.isVip?\`<button class="btn btn-warn" onclick="removeVipNum(\${JSON.stringify(u.num)})">إزالة VIP</button>\`:\`<button class="btn btn-primary" onclick="addVipNum(\${JSON.stringify(u.num)})">+ VIP</button>\`;
    const blockBtn=u.isBlocked?\`<button class="btn btn-success" onclick="removeBlacklistNum(\${JSON.stringify(u.num)})">✅ رفع حظر</button>\`:\`<button class="btn btn-purple" onclick="blockUser(\${JSON.stringify(u.num)})">⛔ حظر</button>\`;
    return \`<tr>
      <td dir="ltr" style="font-family:monospace;color:var(--accent)">\${esc(u.num)}</td>
      <td>\${esc(u.name)}</td>
      <td>\${statusBadge}</td>
      <td>\${progHtml}</td>
      <td>\${customLimitBadge}</td>
      <td><div class="action-row">
        \${!u.isBlocked?vipBtn:''}
        <button class="btn btn-warn" onclick="quickSetLimit(\${JSON.stringify(u.num)})">🔢 حد</button>
        \${!u.isBlocked?blockBtn:blockBtn}
        <button class="btn btn-danger" onclick="deleteUser(\${JSON.stringify(u.num)})">🗑️</button>
      </div></td>
    </tr>\`;
  }).join('');
}

// ── USAGE ──
let _allUsage=[];
function renderUsage(d){
  _allUsage=d.welcomedUsers.map(num=>({
    num,name:d.userNames[num]||'—',
    isVip:(d.vipNumbers||[]).includes(num),
    isBlocked:(d.blacklist||[]).includes(num),
    ...(d.userUsage?d.userUsage[num]:{used:0,images:0,docs:0,limit:20,remaining:20,resetAt:null})
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
    const progHtml=\`<div class="prog-wrap" style="min-width:100px"><div class="prog-bar"><div class="prog-fill \${fillClass}" style="width:\${pct}%"></div></div><div class="prog-text">\${pct}%</div></div>\`;
    const resetStr=u.resetAt?new Date(u.resetAt).toLocaleTimeString('ar',{hour:'2-digit',minute:'2-digit'}):'—';
    return \`<tr>
      <td dir="ltr" style="font-family:monospace;font-size:11px;color:var(--accent)">\${esc(u.num)}</td>
      <td>\${esc(u.name)}</td>
      <td>\${statusBadge}</td>
      <td style="text-align:center">\${u.used}</td>
      <td style="text-align:center">\${u.images}</td>
      <td style="text-align:center">\${u.docs}</td>
      <td style="text-align:center">\${u.isVip?'♾️':u.limit}</td>
      <td style="text-align:center">\${u.isVip?'♾️':u.remaining}</td>
      <td>\${u.isVip?'<span class="badge badge-blue">غير محدود</span>':progHtml}</td>
    </tr>\`;
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
    return \`<tr>
      <td dir="ltr" style="font-family:monospace;color:var(--accent)">\${esc(num)}</td>
      <td>\${esc(d.userNames[num]||'—')}</td>
      <td><span class="badge badge-blue">\${lim} رسالة/يوم</span></td>
      <td><div class="prog-wrap"><div class="prog-bar"><div class="prog-fill \${fillClass}" style="width:\${pct}%"></div></div><div class="prog-text">\${used}/\${lim}</div></div></td>
      <td><button class="btn btn-danger" onclick="resetUserLimitNum(\${JSON.stringify(num)})">↩️ إعادة</button></td>
    </tr>\`;
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
    return \`<tr>
      <td dir="ltr" style="font-family:monospace;color:var(--accent)">\${esc(num)}</td>
      <td>\${esc(d.userNames[num]||'—')}</td>
      <td>\${expiryStr}</td>
      <td>
        <div class="action-row">
          <button class="btn btn-primary" onclick="renewVip(\${JSON.stringify(num)})">🔄 تجديد</button>
          <button class="btn btn-danger" onclick="removeVipNum(\${JSON.stringify(num)})">❌ إزالة</button>
        </div>
      </td>
    </tr>\`;
  }).join('');
}

// ── BLACKLIST ──
function renderBlacklist(d){
  const tb=document.getElementById('blacklist-table');
  const bl=d.blacklist||[];
  if(!bl.length){tb.innerHTML='<tr><td colspan="3" class="empty">لا يوجد مستخدمون محظورون</td></tr>';return;}
  tb.innerHTML=bl.map(num=>{
    return \`<tr>
      <td dir="ltr" style="font-family:monospace;color:var(--red)">\${esc(num)}</td>
      <td>\${esc(d.userNames[num]||'—')}</td>
      <td><button class="btn btn-success" onclick="removeBlacklistNum(\${JSON.stringify(num)})">✅ رفع الحظر</button></td>
    </tr>\`;
  }).join('');
}

// ── REPORTS ──
function renderReports(d){
  const tb=document.getElementById('reports-table');
  if(!d.reports.length){tb.innerHTML='<tr><td colspan="6" class="empty">لا يوجد بلاغات</td></tr>';return;}
  tb.innerHTML=d.reports.map((r,i)=>{
    return \`<tr>
      <td style="color:var(--muted)">\${i+1}</td>
      <td>\${esc(r.name||'—')}</td>
      <td dir="ltr" style="font-size:11px;font-family:monospace;color:var(--accent)">\${esc(r.sender)}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${esc(r.text)}">\${esc(r.text)}</td>
      <td style="font-size:11px;color:var(--muted)">\${esc(r.time)}</td>
      <td><button class="btn btn-purple" onclick="blockUser(\${JSON.stringify(r.sender)})">⛔ حظر</button></td>
    </tr>\`;
  }).join('');
}

// ── ACTIONS ──
async function doAction(action){
  if(action==='clearSessions'&&!confirm('مسح كل الجلسات النشطة؟'))return;
  const r=await api(action);
  toast(r.msg||'✅ تم');
  loadData();
}
async function sendBroadcast(){
  const text=document.getElementById('broadcast-text').value.trim();
  if(!text){toast('اكتب الرسالة أولاً','#f59e0b');return;}
  if(!confirm('إرسال لجميع المستخدمين؟'))return;
  const r=await api('broadcast',{text});
  if(r.ok){toast('✅ '+(r.msg||'بدأ الإرسال'));document.getElementById('broadcast-text').value='';}
  else toast(r.msg||'فشل الإرسال','#dc2626');
}
async function blockUser(num){
  if(!confirm('حظر المستخدم '+num+'؟ سيصله إشعار تلقائي.'))return;
  const r=await api('addBlacklist',{num});
  if(r.ok){toast('⛔ تم الحظر وإشعار المستخدم');loadData();}
  else toast(r.msg||'فشل','#dc2626');
}
async function addBlacklist(){
  const num=document.getElementById('bl-num').value.replace(/\D/g,'');
  if(!num){toast('أدخل رقماً صحيحاً','#f59e0b');return;}
  if(!confirm('حظر المستخدم '+num+'؟'))return;
  const r=await api('addBlacklist',{num});
  if(r.ok){toast('⛔ تم الحظر وإشعار المستخدم');document.getElementById('bl-num').value='';loadData();}
  else toast(r.msg||'فشل','#dc2626');
}
async function removeBlacklistNum(num){
  if(!confirm('رفع الحظر عن '+num+'؟'))return;
  const r=await api('removeBlacklist',{num});
  if(r.ok){toast('✅ تم رفع الحظر');loadData();}
  else toast(r.msg||'فشل','#dc2626');
}
async function addVip(){
  const num=document.getElementById('new-vip').value.replace(/\D/g,'');
  if(!num){toast('أدخل رقماً صحيحاً','#f59e0b');return;}
  const r=await api('addVip',{num});
  if(r.ok){toast('✅ تم إضافة VIP');document.getElementById('new-vip').value='';loadData();}
}
async function addVipNum(num){const r=await api('addVip',{num});if(r.ok){toast('✅ تم إضافة VIP');loadData();}}
async function removeVipNum(num){
  if(!confirm('إزالة '+num+' من VIP؟'))return;
  const r=await api('removeVip',{num});
  if(r.ok){toast('تم الإزالة من VIP');loadData();}
}
async function deleteUser(num){
  if(!confirm('حذف هذا المستخدم نهائياً؟ لا يمكن التراجع.'))return;
  const r=await api('deleteUser',{num});
  if(r.ok){toast('تم الحذف');loadData();}
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
  const r=await api('addVip',{num});
  if(r.ok){toast('✅ تم تجديد VIP لشهر إضافي');loadData();}
  else toast(r.msg||'فشل','#dc2626');
}

  const r=await api('resetUserLimit',{num});
  if(r.ok){toast('تم الإعادة للافتراضي');loadData();}
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

loadData();
setInterval(loadData,30000);
</script>
</body>
</html>`);
    });

    function tryListen(port) {
        server.listen(port, '0.0.0.0')
            .once('listening', () => {
                console.log(`\n🌐 لوحة التحكم: http://localhost:${port}`);
                console.log(`🌐 من جهاز ثاني: http://10.158.171.59:${port}\n`);
            })
            .once('error', (e) => {
                if (e.code === 'EADDRINUSE') {
                    console.log(`⚠️ البورت ${port} مشغول، جاري المحاولة على ${port + 1}...`);
                    server.removeAllListeners('error');
                    server.removeAllListeners('listening');
                    tryListen(port + 1);
                } else {
                    console.error('[server]', e.message);
                }
            });
    }

    tryListen(WEB_PORT);
}

// ============================================================
// WELCOME MESSAGE
// ============================================================
function buildWelcome(name) {
    return buildModeMenu(name);
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
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: true   // جلب الرسائل الفائتة عند إعادة الاتصال
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
        }

        if (connection === 'close') {
            isConnected = false;
            const errCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = errCode !== DisconnectReason.loggedOut;
            console.log('❌ انقطع الاتصال، الكود:', errCode);
            if (shouldReconnect) {
                if (!isReconnecting) {
                    isReconnecting = true;
                    let attempt = 0;
                    // المحاولة الأولى بعد ثانية واحدة فقط، ثم backoff تدريجي أقصاه 30 ثانية
                    const DELAYS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000];
                    const tryReconnect = () => {
                        const delay = DELAYS[Math.min(attempt, DELAYS.length - 1)];
                        attempt++;
                        console.log(`🔄 محاولة إعادة الاتصال #${attempt} خلال ${delay / 1000}ث...`);
                        setTimeout(async () => {
                            try {
                                isReconnecting = false;
                                await startBot();
                            } catch (e) {
                                console.error('[reconnect] فشلت المحاولة:', e.message);
                                isReconnecting = true;
                                tryReconnect();
                            }
                        }, delay);
                    };
                    tryReconnect();
                }
            } else {
                console.log('🚪 تم تسجيل الخروج. احذف مجلد session وأعد التشغيل.');
                isReconnecting = false;
            }
        }
        if (connection === 'open') {
            isReconnecting = false;
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // 'notify' = رسالة جديدة، 'append' = رسائل فائتة — كلاهما مصفوفة
        if (type !== 'notify' && type !== 'append') return;

        const msgList = Array.isArray(messages) ? messages : (messages ? [messages] : []);

        for (const msg of msgList) {
        if (!msg?.message || msg?.key?.fromMe) continue;
        // تجاهل الرسائل القديمة أكثر من 10 دقائق (فقط في حالة append)
        const msgTs = (msg.messageTimestamp || 0) * 1000;
        if (type === 'append' && Date.now() - msgTs > 10 * 60 * 1000) continue;

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
            if (!msgType) continue;

            const jid     = msg.key?.remoteJid;
            if (!jid) continue;

            // تحديد نوع المحادثة
            const isGroup = jid.endsWith('@g.us');

            // استخراج رقم المرسل بشكل موثوق
            const sender = cleanNumber(
                msg.key?.participant || (isGroup ? msg.key?.participant : jid)
            );
            if (!sender) return;

            const isAdmin = sender === ADMIN_NUMBER;
            userChatLastSeen[sender] = Date.now(); // تحديث آخر نشاط

            // تعريف reply و react أولاً — قبل أي كود يستخدمهما
            const WA_CHUNK_LIMIT = 3800;
            function splitMessage(text) {
                if (text.length <= WA_CHUNK_LIMIT) return [text];
                const chunks = [];
                const lines = text.split('\n');
                let current = '';
                for (const line of lines) {
                    const candidate = current ? current + '\n' + line : line;
                    if (candidate.length > WA_CHUNK_LIMIT) {
                        if (current.trim()) chunks.push(current.trim());
                        current = line;
                    } else {
                        current = candidate;
                    }
                }
                if (current.trim()) chunks.push(current.trim());
                return chunks.filter(c => c.length > 0);
            }
            const reply = async (text) => {
                try {
                    const parts = splitMessage(text);
                    if (parts.length === 1) {
                        await sock.sendMessage(jid, { text: parts[0] }, { quoted: msg });
                    } else {
                        await sock.sendMessage(jid, { text: parts[0] }, { quoted: msg });
                        for (let i = 1; i < parts.length; i++) {
                            await new Promise(r => setTimeout(r, 500));
                            await sock.sendMessage(jid, { text: parts[i] });
                        }
                    }
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
            // فحص الحظر (Blacklist) — قبل أي معالجة
            // ============================================================
            if (blacklist.includes(sender)) {
                // نرسل رسالة الحظر مرة واحدة كل ساعة فقط (anti-spam)
                const now = Date.now();
                const lastNotify = _lastAdminNotify[`bl_${sender}`] || 0;
                if (now - lastNotify > 60 * 60_000) {
                    _lastAdminNotify[`bl_${sender}`] = now;
                    await reply(BLACKLIST_MSG);
                }
                // حذف جلسة المحظور فوراً لتحرير الذاكرة
                delete userChats[sender];
                return;
            }

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

            // ============================================================
            // أوامر الأدمن — تُدار من لوحة التحكم فقط
            // الأدمن يستخدم البوت كمستخدم عادي
            // ============================================================

            // ============================================================
            // استخراج / تحديث اسم المستخدم
            // ============================================================
            let userName = userNames[sender];
            const pushName = msg.pushName?.trim(); // pushName هو الخاصية الصحيحة الوحيدة في messages.upsert
            if (pushName && pushName !== userName) {
                userNames[sender] = pushName;
                userName = pushName;
                saveData();
            }

            // ============================================================
            // رسالة الترحيب (للمستخدمين الجدد فقط - في المحادثات الخاصة)
            // ============================================================
            if (!welcomedUsers[sender]) {
                welcomedUsers[sender] = true;
                userChats[sender] = [];
                if (userName) {
                    userChats[sender].push({ role: 'user',      content: `[اسم المستخدم: ${userName}]` });
                    userChats[sender].push({ role: 'assistant', content: `أهلاً ${userName}، كيف أستطيع مساعدتك؟` });
                }
                saveData();
                // رسالة الترحيب فقط في المحادثات الخاصة
                if (!isGroup) {
                    await reply(buildWelcome(userName));
                    const isProcessable = body || ['imageMessage','documentMessage'].includes(msgType);
                    if (!isProcessable) return;
                }
            }

            // ============================================================
            // معالجة أنواع الرسائل
            // ============================================================

            // --- صور ---
            if (msgType === 'imageMessage') {
                if (!checkSpam(sender)) {
                    await reply('⚠️ أرسلت صوراً بشكل متسارع، انتظر ثوانٍ ثم أعد المحاولة.');
                    return;
                }
                const isVIPimg = isAdmin || isActiveVIP(sender);
                if (!isVIPimg && !checkDailyLimit(sender, 'image')) {
                    await reply(
                        `⚠️ *وصلت للحد اليومي للصور* (${DAILY_IMG_LIMIT} صور/يوم)\n\n` +
                        `للاشتراك المميز (غير محدود):\n👤 wa.me/972593850520`
                    );
                    return;
                }
                await react('👍');
                try {
                    const imgMsg   = message.imageMessage;
                    const imgSize  = imgMsg?.fileLength || 0;
                    if (imgSize > 8 * 1024 * 1024) {
                        await react('❌');
                        await reply(`حجم الصورة كبير جداً (${(imgSize/1024/1024).toFixed(1)}MB).\nالحد الأقصى 8MB.`);
                        return;
                    }
                    const mime     = imgMsg?.mimetype || 'image/jpeg';
                    const buffer   = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger: { level: 'silent', child: () => ({ level: 'silent' }) }
                    });
                    if (!buffer || buffer.length === 0) {
                        await react('❌');
                        await reply('لم أتمكن من تنزيل الصورة، يرجى المحاولة مرة أخرى.');
                        return;
                    }
                    stats.totalImages++;
                    saveData();
                    const res = await askAIWithImage(buffer.toString('base64'), body, userName, mime);
                    // حفظ وصف الصورة في السياق
                    if (!userChats[sender]) userChats[sender] = [];
                    userChats[sender].push({ role: 'user',      content: body ? `[أرسل صورة مع رسالة: ${body}]` : '[أرسل صورة]' });
                    userChats[sender].push({ role: 'assistant', content: res });
                    await reply(res);
                    await react('✅');
                } catch (e) {
                    console.error('[image]', e.message);
                    await reply('لم أتمكن من تحليل الصورة، يرجى المحاولة مرة أخرى.');
                    await react('❌');
                }
                return;
            }

            // --- ملفات PDF ---
            if (msgType === 'documentMessage') {
                if (!checkSpam(sender)) {
                    await reply('⚠️ أرسلت ملفات بشكل متسارع، انتظر ثوانٍ ثم أعد المحاولة.');
                    return;
                }
                if (!checkDailyLimit(sender, 'pdf')) {
                    await reply('⚠️ وصلت للحد اليومي للملفات (10 ملفات/يوم).');
                    return;
                }
                await react('⏳');
                try {
                    const docMsg = message.documentMessage;
                    const mime = docMsg?.mimetype || '';
                    const fileName = docMsg?.fileName || 'ملف';
                    const caption = body || '';

                    // فقط PDF مدعوم
                    if (mime !== 'application/pdf') {
                        await react('ℹ️');
                        const ext = fileName.split('.').pop().toUpperCase();
                        await reply(
                            `📎 "${fileName}"\n` +
                            `النوع (${ext}) غير مدعوم حالياً.\n` +
                            `أرسل الملف بصيغة PDF، أو إذا كان Word/Excel يمكنك تصديره كـ PDF وإرساله. 📄`
                        );
                        return;
                    }

                    // فحص حجم الملف (أقصى 1MB)
                    const fileSize = docMsg?.fileLength || 0;
                    if (fileSize > 1 * 1024 * 1024) {
                        await react('❌');
                        await reply(`حجم الملف كبير جداً (${(fileSize/1024/1024).toFixed(1)}MB).\nالحد الأقصى المسموح 1MB فقط.\n\nيرجى ضغط الملف أو إرسال جزء منه. 📄`);
                        return;
                    }

                    // تنزيل الملف
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger: { level: 'silent', child: () => ({ level: 'silent' }) }
                    });

                    if (!buffer || buffer.length === 0) {
                        await react('❌');
                        await reply('لم أتمكن من تنزيل الملف، يرجى المحاولة مرة أخرى.');
                        return;
                    }

                    // فحص Magic Bytes — التحقق أن الملف PDF حقيقي
                    if (!buffer || buffer.length < 4 || buffer.slice(0,4).toString('ascii') !== '%PDF') {
                        await react('❌');
                        await reply('الملف ليس PDF حقيقياً، يرجى إرسال ملف PDF صحيح.');
                        return;
                    }

                    // تحويل PDF دائماً لصور بـ mutool (يقرأ النص والصور معاً)
                    console.log(`[PDF] جاري تحويل "${fileName}" بـ mutool...`);
                    const tmpDir = `${os.tmpdir()}/pdf_${sender}_${Date.now()}`;
                    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
                    try {
                        const pdfPath = `${tmpDir}/input.pdf`;
                        fs.writeFileSync(pdfPath, buffer);

                        await new Promise((resolve, reject) => {
                            execFile('mutool', [
                                'convert',
                                '-o', `${tmpDir}/page-%d.jpg`,
                                '-O', 'resolution=150',
                                pdfPath
                            ], { timeout: 30_000 }, (err, _so, se) => {
                                if (err) return reject(new Error(`mutool: ${se || err.message}`));
                                resolve();
                            });
                        });

                        const pageFiles = fs.readdirSync(tmpDir)
                            .filter(f => f.startsWith('page-') && f.endsWith('.jpg'))
                            .sort();

                        if (pageFiles.length === 0) throw new Error('mutool لم ينتج أي صور');
                        console.log(`[PDF] تم تحويل ${pageFiles.length} صفحة من "${fileName}"`);

                        const pages = pageFiles.map(f =>
                            fs.readFileSync(`${tmpDir}/${f}`).toString('base64')
                        );

                        // استخراج النص أيضاً كـ fallback للأسئلة النصية
                        let docText = '';
                        try {
                            const parsed = await pdfParse(buffer);
                            docText = (parsed.text || '').trim();
                        } catch (_) {}

                        stats.totalDocs = (stats.totalDocs || 0) + 1;
                        saveData();

                        // حفظ الصفحات والنص معاً في pending
                        userPdfPending[sender] = {
                            fileName,
                            docText,
                            pages,
                            expiresAt: Date.now() + 5 * 60_000
                        };
                        await react('📄');
                        await reply(
                            `📄 *تم قراءة الملف بنجاح: "${fileName}"*\n` +
                            `(${pageFiles.length} صفحة — يقرأ النصوص والصور معاً)\n\n` +
                            `هل تريد أن أجيبك من هذا الملف فقط؟\n` +
                            `أرسل *نعم* للدخول لوضع الملف 📑\n` +
                            `أو *لا* للمتابعة بشكل عادي`
                        );
                    } catch (imgErr) {
                        console.error('[PDF]', imgErr.message);
                        await react('❌');
                        await reply(`عذراً، لم أتمكن من قراءة "${fileName}".\nتأكد أن الملف غير محمي بكلمة مرور.`);
                    } finally {
                        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
                    }

                } catch (e) {
                    console.error('[document]', e.message);
                    await reply('حدث خطأ أثناء قراءة الملف، يرجى المحاولة مرة أخرى.');
                    await react('❌');
                }
                return;
            }

            // --- فيديو ---
            if (msgType === 'videoMessage') {
                await react('ℹ️');
                await reply(
                    `عذراً، الفيديوهات غير مدعومة حالياً.\n` +
                    `يمكنك أخذ لقطة شاشة وإرسالها كصورة إذا أردت تحليل محتوى معين. 📸`
                );
                return;
            }

            // --- صوت (Voxtral by Mistral) ---
            if (msgType === 'audioMessage' || msgType === 'pttMessage') {
                if (!checkSpam(sender)) {
                    await reply('⚠️ أرسلت رسائل بشكل متسارع، انتظر ثوانٍ ثم أعد المحاولة.');
                    return;
                }
                await react('🎙️');
                try {
                    const audioMsg = message.audioMessage || message.pttMessage || {};
                    const mime = audioMsg?.mimetype || 'audio/ogg; codecs=opus';
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger: { level: 'silent', child: () => ({ level: 'silent' }) }
                    });
                    if (!buffer || buffer.length === 0) {
                        await react('❌');
                        await reply('لم أتمكن من تنزيل الرسالة الصوتية، حاول مرة أخرى.');
                        return;
                    }

                    // فحص الحد اليومي
                    const isVIPaudio = vipNumbers.includes(sender);
                    if (!isAdmin && !isVIPaudio) {
                        const quota = checkDailyMessages(sender);
                        if (!quota.allowed) {
                            await react('⛔');
                            await reply(`⚠️ وصلت للحد اليومي. رصيدك يتجدد منتصف الليل.`);
                            return;
                        }
                    }

                    // Voxtral يفهم الصوت ويرد مباشرة — بدون OpenAI
                    if (!userChats[sender]) userChats[sender] = [];
                    const res = await transcribeAndReplyAudio(
                        buffer, mime, body, userName, userChats[sender]
                    );

                    // حفظ في السياق
                    userChats[sender].push({ role: 'user',      content: body ? `[رسالة صوتية + نص: ${body}]` : '[رسالة صوتية]' });
                    userChats[sender].push({ role: 'assistant', content: res });

                    stats.totalMessages++;
                    saveData();

                    await reply(`🎙️ ${res}`);
                    await react('✅');

                } catch (audioErr) {
                    console.error('[audio/voxtral]', audioErr.message);
                    if (audioErr.message === 'AUTH_ERROR') {
                        notifyAdmin('⚠️ خطأ 401 في Voxtral — تحقق من MISTRAL_API_KEY');
                        await react('❌');
                        await reply('عذراً، مشكلة في إعدادات الخدمة. تم إشعار الأدمن.');
                    } else if (audioErr.message === 'QUOTA_ERROR') {
                        await react('❌');
                        await reply('عذراً، نفاد رصيد Mistral API مؤقتاً. تم إشعار الأدمن.');
                    } else {
                        await react('❌');
                        await reply('عذراً، حدث خطأ في معالجة الرسالة الصوتية. حاول مجدداً أو اكتب رسالتك نصياً. ✍️');
                    }
                }
                return;
            }

            // --- نص ---
            if (!body) return;

            // ============================================================
            // كشف "نعم" لإرسال النطق الصوتي (TTS)
            // إذا كان المستخدم في انتظار نطق مصطلح أو دواء وأرسل "نعم"
            // ============================================================
            const bodyTrimmed = body.trim();

            // ============================================================
            // وضع PDF — إذا كان المستخدم في انتظار إذن PDF
            // ============================================================
            if (userPdfPending[sender] && Date.now() < userPdfPending[sender].expiresAt) {
                const isYesPdf = /^(نعم|yes|أيوه|اه|ايوه|yep|yeah)$/i.test(bodyTrimmed);
                const isNoPdf  = /^(لا|no|لأ)$/i.test(bodyTrimmed);
                if (isYesPdf) {
                    userPdfContext[sender] = { fileName: userPdfPending[sender].fileName, docText: userPdfPending[sender].docText, pages: userPdfPending[sender].pages || null };
                    delete userPdfPending[sender];
                    await react('📑');
                    await reply(
                        `📑 *تم تفعيل وضع الملف*\n"${userPdfContext[sender].fileName}"\n\n` +
                        `الآن سأجيب على أسئلتك من هذا الملف فقط.\n` +
                        `اكتب *خروج* للخروج من وضع الملف\n` +
                        `اكتب *قائمة* للرجوع للقائمة الرئيسية`
                    );
                    return;
                }
                if (isNoPdf) {
                    delete userPdfPending[sender];
                    await react('✅');
                    await reply('حسناً، سأتابع معك بشكل عادي. 👍');
                    return;
                }
            }

            // ============================================================
            // وضع PDF النشط — الإجابة من الملف فقط
            // ============================================================
            if (userPdfContext[sender]) {
                const { fileName, docText, pages } = userPdfContext[sender];

                // خروج من وضع الملف
                if (/^خروج$/i.test(bodyTrimmed)) {
                    delete userPdfContext[sender];
                    await react('✅');
                    await reply('تم الخروج من وضع الملف. يمكنك الآن إرسال أي سؤال بشكل عادي. 👋');
                    return;
                }

                // رجوع للقائمة الرئيسية
                if (/^قائمة$/i.test(bodyTrimmed)) {
                    delete userPdfContext[sender];
                    delete userModes[sender];
                    userChats[sender] = [];
                    await react('🔄');
                    await reply(buildModeMenu(userName || ''));
                    return;
                }

                // anti-spam
                if (!checkSpam(sender)) {
                    await reply('⚠️ أرسلت رسائل بشكل متسارع، انتظر ثوانٍ ثم أعد المحاولة.');
                    return;
                }

                await react('⏳');
                try {
                    const pdfSystemPrompt =
                        `أنت مساعد ذكي يساعد المستخدم على فهم محتوى الملف: "${fileName}".\n` +
                        `أسلوبك طبيعي ومرن — اشرح وحلّل وأجب كما يفهم الإنسان، لا تقتبس حرفياً.\n` +
                        `اللغة: أجب بنفس لغة سؤال المستخدم (عربي أو إنجليزي).\n` +
                        `السياق: ردودك مبنية على محتوى الملف — النصوص والصور معاً.\n` +
                        `إذا سأل عن شيء غير موجود في الملف: أخبره بلطف.`;

                    let res;
                    if (pages && pages.length > 0) {
                        // استخدام الصور للإجابة (يقرأ النص والصور معاً)
                        const imageContents = pages.map(b64 => ({
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${b64}` }
                        }));
                        res = await callMistral({
                            model: 'pixtral-large-latest',
                            messages: [
                                { role: 'system', content: pdfSystemPrompt },
                                { role: 'user', content: [...imageContents, { type: 'text', text: body }] }
                            ],
                            max_tokens: 2500,
                            temperature: 0.3
                        });
                    } else {
                        // fallback: نص فقط
                        res = await askAI([
                            { role: 'system', content: pdfSystemPrompt },
                            { role: 'user',   content: `محتوى الملف:\n${docText.slice(0, 14000)}\n\nسؤال المستخدم: ${body}` }
                        ]);
                    }
                    await reply(res);
                    await react('✅');
                } catch (e) {
                    console.error('[PDF mode]', e.message);
                    await react('❌');
                    await reply('حدث خطأ، يرجى المحاولة مرة أخرى.');
                }
                return;
            }


            const isYes = /^(نعم|yes|نعم\s*✅|أيوه|اه|ايوه|yep|yeah)$/i.test(bodyTrimmed);
            if (isYes && userTTSPending[sender] && Date.now() < userTTSPending[sender].expiresAt) {
                const { term, termAr } = userTTSPending[sender];
                delete userTTSPending[sender];
                await react('🔊');
                try {
                    // إرسال النطق الإنجليزي
                    if (term) {
                        const audioEn = await generateTTS(term, 'en');
                        await sendVoiceNote(jid, audioEn, msg);
                    }
                    // إرسال النطق العربي إذا وُجد (اسم الدواء أو المصطلح بالعربية)
                    if (termAr) {
                        await new Promise(r => setTimeout(r, 600));
                        const audioAr = await generateTTS(termAr, 'ar');
                        await sendVoiceNote(jid, audioAr);
                    }
                    await react('✅');
                } catch (ttsErr) {
                    console.error('[TTS] ❌ خطأ كامل:', ttsErr);
                    await react('❌');
                    await reply('عذراً، لم أتمكن من توليد الصوت حالياً. حاول مرة أخرى لاحقاً. 🔇');
                }
                return;
            }
            // إذا أرسل "لا" أو أي شيء آخر بعد عرض النطق → نمسح الانتظار ونكمل طبيعي
            if (userTTSPending[sender]) delete userTTSPending[sender];

            // أوامر المستخدم (!مساعدة، !مسح، !رصيد، !لغة، !ملخص) — تعمل دائماً
            const isVIPcmd = isActiveVIP(sender);
            const handledCmd = await handleUserCommand(body, sender, reply, react, isAdmin, isVIPcmd);
            if (handledCmd) return;

            // ============================================================
            // كشف طلب النطق الصوتي: "نطق [كلمة/جملة]"
            // ============================================================
            const ttsMatch = bodyTrimmed.match(/^(?:نطق|صوت|اسمعني|اقرأ|نطقها?|ارسل صوت)\s+(.+)$/i);
            if (ttsMatch) {
                const isVIPnow = isActiveVIP(sender);
                if (!isAdmin && !isVIPnow) {
                    const ttsCheck = checkDailyTTS(sender);
                    if (!ttsCheck.allowed) {
                        await reply(
                            `⚠️ *وصلت للحد اليومي للصوت* (${DAILY_TTS_LIMIT} مرات)\n\n` +
                            `للاشتراك المميز (غير محدود):\n👤 wa.me/972593850520`
                        );
                        return;
                    }
                }
                const ttsText = ttsMatch[1].trim();
                await react('🔊');
                try {
                    const lang = /[\u0600-\u06FF]/.test(ttsText) ? 'ar' : 'en';
                    const audio = await generateTTS(ttsText, lang);
                    await sendVoiceNote(jid, audio, msg);
                    await react('✅');
                } catch (e) {
                    await react('❌');
                    await reply('عذراً، لم أتمكن من توليد الصوت حالياً. حاول مرة أخرى لاحقاً. 🔇');
                }
                return;
            }

            // ============================================================
            // كشف طلب الترجمة: "ترجم [نص]" — يرسل الترجمة + صوت تلقائياً
            // ============================================================
            const translateMatch = bodyTrimmed.match(/^(?:ترجم|translate|ترجمة)\s+(.+)$/i);
            if (translateMatch) {
                const isVIPnow = isActiveVIP(sender);
                const textToTranslate = translateMatch[1].trim();
                await react('⏳');
                try {
                    // تحديد لغة المصدر والهدف
                    const isArabic = /[\u0600-\u06FF]/.test(textToTranslate);
                    const targetLang = isArabic ? 'English' : 'العربية';
                    const targetLangCode = isArabic ? 'en' : 'ar';

                    const translationResult = await callMistral({
                        model: 'mistral-small-latest',
                        messages: [
                            { role: 'system', content: `أنت مترجم محترف. ترجم النص التالي إلى ${targetLang}. أرسل الترجمة فقط بدون أي شرح أو تعليق.` },
                            { role: 'user', content: textToTranslate }
                        ],
                        max_tokens: 500,
                        temperature: 0.3
                    });

                    const originalLabel = isArabic ? '🇸🇦 الأصلي:' : '🔤 Original:';
                    const translatedLabel = isArabic ? '🇬🇧 الترجمة:' : '🇸🇦 الترجمة:';
                    await reply(`${originalLabel} ${textToTranslate}\n\n${translatedLabel} ${translationResult}`);

                    // إرسال الصوت تلقائياً بدون طلب "نعم"
                    if (!isAdmin && !isVIPnow) {
                        const ttsCheck = checkDailyTTS(sender);
                        if (!ttsCheck.allowed) {
                            await reply(`⚠️ وصلت للحد اليومي للصوت (${DAILY_TTS_LIMIT} مرات). الترجمة فوق بدون صوت.`);
                            await react('✅');
                            return;
                        }
                    }
                    await new Promise(r => setTimeout(r, 300));
                    const audio = await generateTTS(translationResult, targetLangCode);
                    await sendVoiceNote(jid, audio);
                    await react('✅');
                } catch (e) {
                    console.error('[translate]', e.message);
                    await react('❌');
                    await reply('عذراً، حدث خطأ أثناء الترجمة. حاول مرة أخرى.');
                }
                return;
            }

            // anti-spam: منع الإرسال المتسارع جداً
            if (!checkSpam(sender)) {
                await reply('⚠️ أرسلت رسائل بشكل متسارع، انتظر ثوانٍ ثم أعد المحاولة.');
                return;
            }

            // الحد اليومي للرسائل (الأدمن وVIP بلا حدود)
            const isVIP = isActiveVIP(sender);
            let _quotaCommit = null;
            if (!isAdmin && !isVIP) {
                const quota = checkDailyMessages(sender);
                if (!quota.allowed) {
                    await reply(
                        `⚠️ *وصلت للحد اليومي (${DAILY_MSG_LIMIT} رسالة)*\n\n` +
                        `سيتجدد رصيدك تلقائياً في منتصف الليل 🔄\n\n` +
                        `للاستمرار الآن تواصل مع المهندس نادر:\n` +
                        `👤 wa.me/972593850520`
                    );
                    const uName = userNames[sender] ? `${userNames[sender]} (${sender})` : sender;
                    notifyAdmin(`⚠️ المستخدم ${uName} تجاوز حده اليومي (${DAILY_MSG_LIMIT} رسالة).`);
                    return;
                }
                _quotaCommit = quota.commit;
            }

            await react('👍');

            const maxHist = isVIP ? 60 : MAX_HISTORY;

            if (!userChats[sender]) userChats[sender] = [];

            // سياق أولي إذا كانت الجلسة فارغة
            if (userChats[sender].length === 0 && userName) {
                userChats[sender].push({ role: 'user',      content: `[اسم المستخدم: ${userName}]` });
                userChats[sender].push({ role: 'assistant', content: `أهلاً ${userName}، كيف أستطيع مساعدتك؟` });
            }

            stats.totalMessages++;
            saveData();

            // تقليم السياق قبل الإضافة
            if (userChats[sender].length >= maxHist)
                userChats[sender] = userChats[sender].slice(-(maxHist - 1));

            userChats[sender].push({ role: 'user', content: body });

            // اختيار system prompt ذكي: طبي للأسئلة الطبية، عام للباقي
            const smartPrompt = getSmartSystemPrompt(body, userLanguages[sender]);

            const res = await askAI([
                { role: 'system', content: smartPrompt },
                ...userChats[sender]
            ]);

            userChats[sender].push({ role: 'assistant', content: res });

            // إضافة عدد الرسائل المتبقية في نهاية الرد (للمستخدم العادي فقط)
            let finalRes = res;
            if (!isAdmin && !isVIP && _quotaCommit) {
                _quotaCommit(); // خصم الرسالة
                const rec = getDailyRecord(sender);
                const remaining = Math.max(0, getUserDailyLimit(sender) - rec.messages);
                if (remaining <= 5) {
                    finalRes += `\n\n─────────────\n⚠️ *تنبيه:* متبقي لك *${remaining}* رسالة اليوم.\n_للاشتراك المميز: wa.me/972593850520_`;
                } else {
                    finalRes += `\n\n_💬 رسائل متبقية اليوم: ${remaining}_`;
                }
            } else if (_quotaCommit) {
                _quotaCommit();
            }

            await reply(finalRes);
            await react('✅');

            // ── عرض النطق الصوتي للمصطلحات الطبية والأدوية تلقائياً ──
            if (isMedicalQuery(body)) {
                const termEn = extractTermForTTS(res);
                let termAr = null;
                const arMatch = res.match(/(?:العربية|بالعربية)\s*[:\-–]\s*([^\n]{2,40})/i);
                if (arMatch) termAr = arMatch[1].replace(/[*_📌⭐]/g, '').trim().split(/[،,\n]/)[0].trim();

                if (termEn) {
                    userTTSPending[sender] = {
                        term:   termEn,
                        termAr: termAr || null,
                        expiresAt: Date.now() + 3 * 60_000
                    };
                    await new Promise(r => setTimeout(r, 400));
                    await reply(`🔊 *هل تريد سماع النطق الصحيح؟*\nأرسل *نعم* وسأرسل لك الصوت فوراً 🎙️`);
                }
            }


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
        } // نهاية for loop (معالجة الرسائل الفائتة)
    });
}

// ============================================================
// START
// ============================================================
// تنظيف الذاكرة كل ساعة
setInterval(cleanMemory, 60 * 60_000);

// فحص انتهاء VIP كل ساعة
setInterval(checkVIPExpiry, 60 * 60_000);





console.log(`🚀 جاري تشغيل ${BOT_NAME}...`);
startQRServer();
startBot();
