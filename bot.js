'use strict';

require('dotenv').config();

const pdfParse = require('pdf-parse');
const http = require('http');
const fs   = require('fs');
const wa   = require('./whatsappClient'); // طبقة WhatsApp Cloud API الرسمية
const { adaptCloudMessage } = require('./cloudAdapter');


// ============================================================
// CONFIG
// ============================================================
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

if (!MISTRAL_API_KEY) {
    console.error('❌ خطأ فادح: لم يتم تعيين MISTRAL_API_KEY في .env');
    process.exit(1);
}
const ADMIN_NUMBER    = (process.env.ADMIN_NUMBER || '972593850520').trim().replace(/\+/g, '');
const BOT_NAME        = 'MedTerm';
const DATA_FILE       = './bot_data.json';
const WEB_PORT        = process.env.PORT || 8080;
const PDF_CACHE_DIR   = './pdf_cache';  // مجلد حفظ كاش ملفات PDF
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;

if (!VERIFY_TOKEN) {
    console.error('❌ خطأ فادح: لم يتم تعيين VERIFY_TOKEN في .env (مطلوب لإعداد Webhook في لوحة Meta)');
    process.exit(1);
}

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
    // ملاحظة: لا نفحص IP لأن Ngrok يغير الـ IP
    return true;
}
function parseCookie(str) {
    const result = {};
    for (const part of str.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 1) continue;
        try {
            const key = decodeURIComponent(part.slice(0, idx).trim());
            const val = decodeURIComponent(part.slice(idx + 1).trim());
            if (key) result[key] = val;
        } catch (_) {}
    }
    return result;
}
// تنظيف sessions منتهية كل ساعة
setInterval(() => {
    const now = Date.now();
    for (const tok of Object.keys(_sessions))
        if (now - _sessions[tok].createdAt > SESSION_TTL_MS) delete _sessions[tok];
}, 60 * 60_000);

// في Cloud API لا يوجد QR ولا "اتصال" بمعنى Baileys — البوت متصل دائماً عبر HTTP API
// نحتفظ بـ isConnected=true دائماً للحفاظ على بقية الكود يعمل بدون تعديل في كل مكان يفحصها
let isConnected = true;
const MAX_HISTORY     = 12;              // ✅ تحسين: تقليص من 30 → 12 رسالة (توفير 30-50% على المحادثات الطويلة)
const API_TIMEOUT_MS  = 120_000;        // 120 ثانية timeout للـ API (pixtral-large يحتاج وقت أكثر)

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
        userLimitsUsage: {},  // استهلاك كل مستخدم { sender: { messages, images, docs, tts, activatedAt } }
        trialNotified:  {},  // { sender: true } — أُرسلت له رسالة الفترة المجانية
        blacklist:      [],   // أرقام محظورة
        userLanguages:  {},   // لغة كل مستخدم { sender: 'ar'|'en'|... }
        stats:          { totalMessages: 0, totalImages: 0, totalMedical: 0, totalDocs: 0 }
    };
}

let _saveTimer = null;
function saveData() {
    // debounce: تأخير 200ms
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
        try {
            const tmp = DATA_FILE + '.tmp';
            await fs.promises.writeFile(tmp, JSON.stringify(
                { userNames, welcomedUsers, vipNumbers, vipExpiry, reports, userLimits, userLimitsUsage, trialNotified, blacklist, userLanguages, stats },
                null, 2
            ));
            await fs.promises.rename(tmp, DATA_FILE);
        } catch (e) {
            console.error('[saveData] خطأ:', e.message);
        }
    }, 500);
}

let { userNames, welcomedUsers, vipNumbers, vipExpiry, reports, userLimits, userLimitsUsage, trialNotified, blacklist, userLanguages, stats } = loadData();

// ضمان وجود الحقول
if (!Array.isArray(reports))   reports = [];
if (!userLimits)               userLimits = {};
if (!userLimitsUsage)          userLimitsUsage = {};
if (!trialNotified)            trialNotified = {};
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
let userTTSPending  = {};  // { sender: { term, lang, expiresAt } } — انتظار "نعم" لإرسال النطق
let userPdfContext  = {};  // { sender: { fileName, docText } } — محتوى PDF النشط
let userPdfPending  = {};  // { sender: { fileName, docText, expiresAt } } — انتظار إذن المستخدم
// sock غير مستخدم في Cloud API — كل الإرسال عبر wa.* (HTTP)

// تنظيف الذاكرة: احتفظ بآخر 800 جلسة الأكثر نشاطاً (LRU)
function cleanMemory() {
    const keys = Object.keys(userChats);
    if (keys.length > 800) {
        const sorted = keys.sort((a, b) => (userChatLastSeen[a] || 0) - (userChatLastSeen[b] || 0));
        const toDelete = sorted.slice(0, keys.length - 800);
        toDelete.forEach(k => { delete userChats[k]; delete userChatLastSeen[k]; });
        console.log(`[cleanMemory] حُذف ${toDelete.length} جلسة قديمة (LRU)`);
    }
    // تنظيف userPdfContext القديمة (أكثر من 6 ساعات)
    const SIX_HOURS = 6 * 60 * 60_000;
    const now = Date.now();
    for (const k of Object.keys(userPdfContext)) {
        if ((userPdfContext[k]?.loadedAt || 0) && now - userPdfContext[k].loadedAt > SIX_HOURS)
            delete userPdfContext[k];
    }
}


// ============================================================
// PDF CACHE — حفظ واسترجاع نص PDF لتجنب إعادة الاستخراج
// ============================================================
function pdfCacheKey(fileName, buffer) {
    // مفتاح مزدوج: اسم الملف + هاش MD5 للمحتوى (أدق)
    const hash = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 16);
    const safeName = fileName.replace(/[^a-zA-Z0-9\u0600-\u06FF._-]/g, '_').slice(0, 60);
    return `${safeName}__${hash}`;
}

function pdfCachePath(key) {
    return require('path').join(PDF_CACHE_DIR, `${key}.json`);
}

async function pdfCacheGet(key) {
    try {
        const p = pdfCachePath(key);
        const raw = await fs.promises.readFile(p, 'utf-8');
        const data = JSON.parse(raw);
        // تحقق من صحة البيانات
        if (!data || !data.docText) return null;
        return data; // { fileName, docText, pageCount, savedAt }
    } catch (_) { return null; }
}

async function pdfCacheSet(key, fileName, docText, pageCount) {
    try {
        if (!fs.existsSync(PDF_CACHE_DIR))
            await fs.promises.mkdir(PDF_CACHE_DIR, { recursive: true });
        const p = pdfCachePath(key);
        await fs.promises.writeFile(p, JSON.stringify({
            fileName,
            docText,
            pageCount,
            savedAt: Date.now()
        }, null, 2));
        console.log(`[pdfCache] حُفظ: ${key} (${Math.round(docText.length/1024)}KB نص)`);
    } catch (e) {
        console.error('[pdfCache] خطأ في الحفظ:', e.message);
    }
}

// تنظيف كاش PDF القديمة (أكثر من 30 يوم) — يُستدعى عند بدء التشغيل وكل 24 ساعة
function cleanPdfCache() {
    try {
        if (!fs.existsSync(PDF_CACHE_DIR)) return;
        const THIRTY_DAYS = 30 * 24 * 60 * 60_000;
        const now = Date.now();
        let deleted = 0;
        for (const f of fs.readdirSync(PDF_CACHE_DIR)) {
            if (!f.endsWith('.json')) continue;
            try {
                const p = require('path').join(PDF_CACHE_DIR, f);
                const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (now - (data.savedAt || 0) > THIRTY_DAYS) {
                    fs.unlinkSync(p);
                    deleted++;
                }
            } catch (_) {}
        }
        if (deleted > 0) console.log(`[pdfCache] تنظيف: حُذف ${deleted} ملف قديم`);
    } catch (e) {
        console.error('[pdfCache] خطأ في التنظيف:', e.message);
    }
}
setInterval(cleanPdfCache, 24 * 60 * 60_000);

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
            if (isConnected) {
                wa.sendText(num, '⚠️ انتهت صلاحية اشتراكك المميز (VIP).\n\nللتجديد تواصل مع المهندس نادر:\n👤 wa.me/972593850520').catch(() => {});
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
    try {
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Jerusalem',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            hour12: false
        });
        const parts = formatter.formatToParts(now);
        const get = type => parts.find(p => p.type === type)?.value || '00';
        // نبني التاريخ بصيغة ISO بدون timezone offset حتى يُعامَل كـ local time
        const hour = get('hour') === '24' ? '00' : get('hour'); // بعض البيئات تُرجع 24 بدل 00
        const built = new Date(`${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`);
        if (!isNaN(built.getTime())) return built;
    } catch (_) {}
    // fallback: toLocaleString — يعمل في معظم البيئات الحديثة
    try {
        const fallback = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
        if (!isNaN(fallback.getTime())) return fallback;
    } catch (_) {}
    // fallback أخير: التوقيت المحلي للسيرفر
    return new Date();
}

// ============================================================
// RATE LIMITING & DAILY MESSAGE QUOTA
// ============================================================
const DAILY_MSG_LIMIT   = 20; // رسائل نصية/24 ساعة لكل مستخدم عادي
const DAILY_IMG_LIMIT   = 5;  // صور يومياً للمستخدم العادي
const DAILY_TTS_LIMIT   = 10; // مرات استخدام الصوت/الترجمة يومياً للمستخدم العادي

// ✅ حد مدة الرسائل الصوتية الواردة (Voxtral + استخراج النص)
const AUDIO_MAX_SECONDS_FREE = 5 * 60;  // 5 دقائق للمجاني
const AUDIO_MAX_SECONDS_VIP  = 15 * 60; // 15 دقيقة للـ VIP
const BLACKLIST_MSG   = '⛔ عذراً، تم حظرك من استخدام هذا البوت.\nللاستفسار تواصل مع المهندس نادر:\n👤 wa.me/972593850520'; // رسالة للمحظورين
// ============================================================
// نظام الحدود الدائمة — لا تتجدد تلقائياً، تُحفظ في bot_data.json
// التجديد فقط: الأدمن يعطي VIP أو يرفع الحد يدوياً
// ============================================================

// الحد اليومي الفعلي: مخصص إن وُجد، وإلا الافتراضي
function getUserDailyLimit(sender) {
    return (userLimits && userLimits[sender] != null) ? userLimits[sender] : DAILY_MSG_LIMIT;
}

// جلب سجل الاستهلاك من الذاكرة الدائمة
function getDailyRecord(sender) {
    if (!userLimitsUsage[sender]) {
        userLimitsUsage[sender] = { messages: 0, images: 0, docs: 0, tts: 0, activatedAt: Date.now() };
    }
    return userLimitsUsage[sender];
}

// إعادة تصفير استهلاك مستخدم (يستدعيها الأدمن فقط عند رفع الحد أو إضافة VIP)
function resetUserUsage(sender) {
    userLimitsUsage[sender] = { messages: 0, images: 0, docs: 0, tts: 0, activatedAt: Date.now() };
    saveData();
}

// فحص الحد للرسائل النصية — يُعيد { allowed, remaining, commit }
function checkDailyMessages(sender) {
    const limit = getUserDailyLimit(sender);
    const rec = getDailyRecord(sender);
    if (rec.messages >= limit) return { allowed: false, remaining: 0, limit, commit: () => {} };
    const remaining = limit - rec.messages - 1;
    const commit = () => { rec.messages++; saveData(); };
    return { allowed: true, remaining, limit, commit };
}

// فحص حد الـ TTS — يُعيد { allowed, remaining, commit }
function checkDailyTTS(sender) {
    const d = getDailyRecord(sender);
    if (d.tts >= DAILY_TTS_LIMIT) return { allowed: false, remaining: 0 };
    const remaining = DAILY_TTS_LIMIT - d.tts - 1;
    return { allowed: true, remaining, commit: () => { d.tts++; saveData(); } };
}

// فحص حد الصور والملفات
function checkDailyLimit(sender, type) {
    const d = getDailyRecord(sender);
    if (type === 'image') { if (d.images >= DAILY_IMG_LIMIT) return false; d.images++; saveData(); return true; }
    if (type === 'pdf')   { if (d.docs   >= 10) return false; d.docs++; saveData(); return true; }
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
        if (isConnected) {
            wa.sendText(sender, '⚠️ انتهت صلاحية اشتراكك المميز (VIP).\n\nللتجديد تواصل مع المهندس نادر:\n👤 wa.me/972593850520').catch(() => {});
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
    // userLimitsUsage محفوظ دائماً — لا تنظيف تلقائي
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
    // ✅ تحسين الاستهلاك: تقليص System Prompt من ~600 token → ~250 token
    // المحتوى مطابق تماماً لكن بصياغة مضغوطة — توفير ~350 token لكل رسالة
    _cachedSystemPrompt = `اسمك "MedTerm"، مساعد ذكاء اصطناعي شامل على واتساب.
التاريخ: ${dateStr} - ${timeStr} (القدس). استخدمه دائماً عند السؤال عن التاريخ.

شخصيتك: مهني ودقيق، ردود مباشرة بدون حشو. اللغة الافتراضية عربية، تجيب بلغة المستخدم فوراً. تجيب على أي سؤال في أي مجال بدون استثناء — لا تقل أبداً "خارج تخصصي".

قواعد الكتابة — مهمة جداً:
• لا تستخدم النجوم * أبداً في ردودك
• لا جداول، لا ---، لا # أو |
• نص عادي متدفق طبيعي فقط
• للتعداد استخدم الأرقام (1. 2. 3.) أو النقطة •
• الإيموجي مسموح لكن باعتدال

خبرتك: طب وأدوية وأعراض وتشخيص أولي، علوم وبرمجة، قانون وأعمال، دين وتاريخ، ترجمة وأدب، وأي موضوع آخر.
للطب: أعطِ معلومة دقيقة كاملة + نبّه بمراجعة الطبيب للحالات الجدية.
اسم المستخدم في السياق، استخدمه أحياناً بشكل طبيعي.`
    return _cachedSystemPrompt;
}

// رسالة الترحيب للمستخدمين الجدد
function buildModeMenu(name) {
    const first = name ? name.split(' ')[0] : null;
    const greeting = first ? `أهلاً ${first}` : 'أهلاً';
    return `${greeting} 👋\n\n*مرحباً بك في بوت MedTerm!*\n\n` +
        `يمكنني مساعدتك في:\n` +
        `🏥 شرح ومساعدتك في أي سؤال\n` +
        `💊 معلومات شاملة عن التخصصات الطبية وباقي التخصصات\n` +
        `⚕️ الإجابة على الأسئلة بشكل عام\n` +
        `🤖 المساعدة في أي موضوع عام\n` +
        `🖼️ تحليل الصور والتقارير الطبية\n` +
        `📄 قراءة وتحليل ملفات PDF\n` +
        `🔊 نطق المصطلحات الطبية والكلمات صوتياً\n` +
        `🌐 الترجمة مع الصوت والنطق\n\n` +
        `─────────────────\n` +
        `✍️ *فقط أرسل سؤالك وسأرد عليك مباشرة!*`;
}

// كشف إذا كانت الرسالة تتعلق بالمجال الطبي (يُستخدم فقط لتفعيل النطق التلقائي للمصطلحات)
function isMedicalQuery(text) {
    const t = text || '';
    // كلمات طبية واضحة
    if (/دواء|دوا|حبة|علاج|مرض|أعراض|جرعة|وصفة|صيدلي|طبيب|مستشفى|عملية|سكري|قلب|كبد|كلى|تحليل|أشعة|رنين|سرطان|التهاب|ألم|حرارة|انفلونزا|covid|corona|كورونا|فيروس|بكتيريا|مضاد حيوي|بنسيلين|ابتوفين|باراسيتامول|اسبرين|ميزوبروستول|فيتامين|هرمون|انسولين|قرحة|ربو|صداع|دوخة|غثيان|اقياء|اسهال|امساك|عظم|مفصل|عصب|نفسي|اكتئاب|قلق|كوليسترول|triglyceride|glucose|hemoglobin|wbc|rbc|platelet|creatinine|uric acid|bilirubin|الغدة|بنكرياس|زائدة|حوصلة|الكوليرا|ملاريا|هيباتيتس|hepatitis|diabetes|hypertension|infection|antibiotic|surgery|physician|hospital|diagnosis|prescription|symptom|medication|dosage|overdose|allergy|immune|vaccine|cholesterol|مصطلح طبي|anatomy|physiology|pathology|pharmacology|medical|medicine|health|صحة|طب|صيدلة/i.test(t)) return true;
    // "ضغط" فقط إذا كانت مع كلمات طبية (ضغط دم، ارتفاع ضغط)
    if (/ضغط\s*دم|ارتفاع\s*ضغط|انخفاض\s*ضغط|ضغط\s*الدم/i.test(t)) return true;
    // "دم" مع سياق طبي فقط (نتجنب: دمار، دمج)
    if (/تحليل دم|فصيلة دم|ضغط دم|نقل دم|كريات دم|دم في|نزيف/i.test(t)) return true;
    return false;
}

// اختيار System Prompt الذكي بناءً على محتوى الرسالة — نظام واحد موحّد (طبي + عام)
function getSmartSystemPrompt(text, userLang) {
    const langSuffix = (userLang && userLang !== 'ar')
        ? `\n\nمهم: يجب أن تجيب على هذا المستخدم بلغة "${userLang}" فقط، حتى لو كتب بالعربية.`
        : '';
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
        // أولاً: ابحث عن كلمة إنجليزية
        const englishWords = clean.match(/[A-Za-z][A-Za-z\s\-]+/g);
        if (englishWords) {
            const term = englishWords[0].trim();
            if (term.length >= 3 && term.length <= 80) return term;
        }
        // ثانياً: ابحث عن كلمة عربية إذا لم توجد إنجليزية
        const arabicWords = clean.match(/[\u0600-\u06FF][\u0600-\u06FF\s]+/g);
        if (arabicWords) {
            const term = arabicWords[0].trim();
            if (term.length >= 2 && term.length <= 80) return term;
        }
    }
    return null;
}

// ============================================================
// TEXT-TO-SPEECH (Google Translate TTS → ffmpeg → OGG Opus)
// ============================================================
const { execFile } = require('child_process');
const os           = require('os');

// تقسيم النص لأجزاء صالحة لـ Google TTS
// لا يوجد حد للنص الكلي — يُقسَّم تلقائياً لأجزاء بحد أقصى 200 حرف لكل طلب
// بدون حذف أي نص مهما طال (جملة أو فقرة أو صفحة كاملة)
function splitTextForTTS(text, maxLen = 190) {
    // تنظيف الرموز غير المدعومة في TTS مع الحفاظ على النص الكامل
    const clean = (text || '')
        .replace(/[*_#\[\](){}|\\^~`<>]/g, '')  // رموز markdown
        .replace(/\s+/g, ' ')                    // مسافات متعددة → مسافة واحدة
        .trim();

    if (!clean) return [];
    if (clean.length <= maxLen) return [clean];

    const chunks = [];
    let remaining = clean;

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining.trim());
            break;
        }

        // أولاً: قطع عند نهاية جملة (. أو ؟ أو ! أو ، أو ؛)
        let cut = -1;
        for (const sep of ['. ', '؟ ', '! ', '، ', '؛ ', '\n']) {
            const idx = remaining.lastIndexOf(sep, maxLen);
            if (idx > maxLen * 0.4) { cut = idx + sep.length - 1; break; }
        }

        // ثانياً: إذا لم توجد نهاية جملة، قطع عند فراغ
        if (cut <= 0) {
            cut = remaining.lastIndexOf(' ', maxLen);
        }

        // ثالثاً: إذا لم يوجد فراغ، قطع بالحد الأقصى
        if (cut <= 0) cut = maxLen;

        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }

    return chunks.filter(c => c.length > 0);
}

async function generateTTS(text, lang = 'en') {
    const ttsLang = lang === 'ar' ? 'ar' : 'en';
    const chunks  = splitTextForTTS(text);
    if (!chunks.length) throw new Error('نص فارغ بعد التنظيف');

    console.log(`[TTS] بدء التوليد: ${chunks.length} جزء، إجمالي ${text.length} حرف`);

    const tmpId    = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const mp3Files = [];

    try {
        // جلب كل جزء كملف MP3 منفصل
        for (let i = 0; i < chunks.length; i++) {
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunks[i])}&tl=${ttsLang}&client=tw-ob&ttsspeed=0.9`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Google TTS HTTP ${response.status} (جزء ${i + 1}/${chunks.length})`);
            const mp3Buffer = Buffer.from(await response.arrayBuffer());
            if (!mp3Buffer || mp3Buffer.length < 100) throw new Error(`MP3 فارغ (جزء ${i + 1})`);
            const mp3File = require('path').join(os.tmpdir(), `tts_${tmpId}_${i}.mp3`);
            await require('fs').promises.writeFile(mp3File, mp3Buffer);
            mp3Files.push(mp3File);
            // تأخير بسيط بين الطلبات لتجنب الحجب
            if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 150));
        }

        const oggFile = require('path').join(os.tmpdir(), `tts_${tmpId}_out.ogg`);

        if (mp3Files.length === 1) {
            // جزء واحد فقط — تحويل مباشر
            await new Promise((resolve, reject) => {
                execFile('ffmpeg', [
                    '-y', '-i', mp3Files[0],
                    '-c:a', 'libopus',
                    '-b:a', '32k',
                    '-vn',
                    oggFile
                ], { timeout: 30_000 }, (err) => {
                    if (err) return reject(new Error(`ffmpeg فشل: ${err.message}`));
                    resolve();
                });
            });
        } else {
            // أكثر من جزء — دمج عبر concat filter
            const inputArgs = [];
            mp3Files.forEach(f => { inputArgs.push('-i', f); });
            const filterInputs = mp3Files.map((_, i) => `[${i}:a]`).join('');
            const filter = `${filterInputs}concat=n=${mp3Files.length}:v=0:a=1[out]`;

            await new Promise((resolve, reject) => {
                execFile('ffmpeg', [
                    '-y', ...inputArgs,
                    '-filter_complex', filter,
                    '-map', '[out]',
                    '-c:a', 'libopus',
                    '-b:a', '32k',
                    oggFile
                ], { timeout: 120_000 }, (err) => { // ✅ رفع timeout لـ 120 ثانية للنصوص الطويلة
                    if (err) return reject(new Error(`ffmpeg concat فشل: ${err.message}`));
                    resolve();
                });
            });
        }

        const oggBuffer = await require('fs').promises.readFile(oggFile);
        require('fs').unlink(oggFile, () => {});

        if (!oggBuffer || oggBuffer.length < 100) throw new Error(`OGG فارغ (${oggBuffer?.length} bytes)`);
        console.log(`[TTS] ✅ ${lang} | ${chunks.length} جزء | ${text.length} حرف → ${(oggBuffer.length/1024).toFixed(0)}KB`);
        return oggBuffer;

    } finally {
        for (const f of mp3Files) require('fs').unlink(f, () => {});
    }
}

// إرسال voice note لـ WhatsApp (Cloud API)
// jid هنا هو رقم الهاتف مباشرة (cleanNumber). quotedMsg غير مستخدم في Cloud API للصوت.
async function sendVoiceNote(jid, audioBuffer, quotedMsg) {
    await wa.sendVoiceNote(jid, audioBuffer);
}

// ✅ قياس مدة ملف صوتي بالثواني عبر ffprobe
// يُعيد null إذا فشل — البوت يكمل بدون فحص المدة
async function getAudioDurationSeconds(buffer) {
    const tmpFile = path.join(os.tmpdir(), `dur_${Date.now()}.ogg`);
    try {
        await fs.promises.writeFile(tmpFile, buffer);
        const duration = await new Promise((resolve, reject) => {
            execFile('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                tmpFile
            ], { timeout: 10_000 }, (err, stdout) => {
                if (err) return reject(err);
                try {
                    const info = JSON.parse(stdout);
                    const dur  = parseFloat(info?.streams?.[0]?.duration || '0');
                    resolve(isNaN(dur) ? null : Math.ceil(dur));
                } catch { resolve(null); }
            });
        });
        return duration;
    } catch {
        return null; // ffprobe غير متوفر أو فشل — نكمل بدون فحص
    } finally {
        fs.unlink(tmpFile, () => {});
    }
}

// تنظيف TTS pending و PDF pending المنتهية كل 10 دقائق
setInterval(() => {
    const now = Date.now();
    for (const k of Object.keys(userTTSPending)) {
        if (now > (userTTSPending[k]?.expiresAt || 0)) delete userTTSPending[k];
    }
    // userPdfPending لا يُستخدم بعد التحسينات (الملف يُفعّل مباشرة) — نظّفه احتياطياً
    for (const k of Object.keys(userPdfPending)) {
        if (now > (userPdfPending[k]?.expiresAt || 0)) delete userPdfPending[k];
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
        if (isConnected) {
            await wa.sendText(ADMIN_NUMBER, message);
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

// ============================================================
// 1. كاش الأسئلة المتكررة — صفر استهلاك للأسئلة المكررة
// ============================================================
// حجم الكاش: 500 سؤال | TTL: 24 ساعة | مشترك بين كل المستخدمين
const _qaCache     = new Map(); // key: نص السؤال المُنقّح → value: { answer, hits, createdAt }
const QA_CACHE_MAX = 500;
const QA_CACHE_TTL = 24 * 60 * 60_000;

// تنقيح السؤال للـ cache key: حذف الأسماء والتشكيل والمسافات الزائدة
function normalizeQuestion(text) {
    return (text || '')
        .replace(/[\u064B-\u065F]/g, '')  // حذف التشكيل
        .replace(/[،,.:؟?!]/g, '')         // حذف الترقيم
        .replace(/\s+/g, ' ')              // مسافة واحدة
        .toLowerCase()
        .trim()
        .slice(0, 120);                    // أول 120 حرف كـ key
}

function qaGet(question) {
    const key = normalizeQuestion(question);
    const hit = _qaCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.createdAt > QA_CACHE_TTL) { _qaCache.delete(key); return null; }
    hit.hits++;
    console.log(`[cache] ✅ HIT (${hit.hits}x): "${key.slice(0,40)}"`);
    return hit.answer;
}

function qaSet(question, answer) {
    // لا نكاش: أسئلة قصيرة جداً أو شخصية أو تحتوي أرقام (نتائج تتغير)
    const q = normalizeQuestion(question);
    if (q.length < 10) return;
    if (/رصيد|اشتراك|وقت|تاريخ|اليوم|الآن|الان|كم|عمري|اسمي/i.test(q)) return;
    // تنظيف الكاش إذا امتلأ
    if (_qaCache.size >= QA_CACHE_MAX) {
        // احذف أقدم 50 عنصر
        const keys = [..._qaCache.keys()].slice(0, 50);
        keys.forEach(k => _qaCache.delete(k));
    }
    _qaCache.set(q, { answer, hits: 0, createdAt: Date.now() });
}

// تنظيف الكاش كل 6 ساعات
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _qaCache.entries())
        if (now - v.createdAt > QA_CACHE_TTL) _qaCache.delete(k);
    console.log(`[cache] تنظيف دوري — الحجم الحالي: ${_qaCache.size}`);
}, 6 * 60 * 60_000);

// ============================================================
// 2. فلتر الرسائل التافهة — ردود جاهزة بدون AI
// ============================================================
const TRIVIAL_RESPONSES = {
    // تعابير موافقة
    ok:    ['حسناً 😊', 'تمام 👍', 'أوكيه 😄'],
    okay:  ['حسناً 😊', 'تمام 👍'],
    تمام:  ['👍', 'تمام!', '😊'],
    حسنا:  ['👍', 'حسناً!'],
    حسناً: ['👍', 'حسناً!'],
    اوك:   ['👍', 'أوكيه!'],
    اوكيه: ['👍', 'أوكيه!'],
    // ضحك
    هه:    ['😄', 'هههه 😄'],
    هههه:  ['😄😄', 'هههه 😂'],
    lol:   ['😂', 'هههه 😂'],
    // شكر
    شكرا:  ['العفو 😊', 'على الرحب والسعة!', 'بكل سرور 🌟'],
    شكراً: ['العفو 😊', 'على الرحب والسعة!'],
    thanks:['You\'re welcome! 😊', 'Anytime! 🌟'],
    thank: ['You\'re welcome! 😊'],
    // تحية إنهاء
    باي:   ['إلى اللقاء 👋', 'مع السلامة 😊'],
    'مع السلامة': ['إلى اللقاء 👋', 'مع السلامة 😊'],
    goodbye: ['Goodbye! 👋', 'Take care! 😊'],
    bye:   ['Goodbye! 👋', 'Bye! 😊'],
};

// فحص إذا الرسالة تافهة وإعادة رد جاهز (أو null)
function getTrivialReply(text) {
    const t = (text || '').trim().toLowerCase()
        .replace(/[!.،؟?]+$/, '')  // حذف علامات الترقيم من النهاية
        .replace(/[\u064B-\u065F]/g, ''); // حذف التشكيل

    // رسائل قصيرة جداً (أقل من 3 حروف) — إيموجي أو حرف واحد
    if (t.length < 3 && !/[a-zA-Z\u0600-\u06FF]/.test(t)) return '😊';

    // بحث في القاموس
    const options = TRIVIAL_RESPONSES[t];
    if (options) return options[Math.floor(Math.random() * options.length)];

    // أنماط إضافية
    if (/^ه+$/.test(t)) return ['😄', '😂', 'هههه 😄'][Math.floor(Math.random()*3)];
    if (/^[👍👌✅🙏😊❤️]+$/.test(text?.trim())) return '😊';

    return null; // ليست تافهة
}

// ============================================================
// 3. ضغط السياق عند الامتلاء
// ============================================================
// بدل حذف الرسائل القديمة، يضغطها بملخص واحد → توفير 70% من tokens السياق
async function compressContext(history) {
    if (!history || history.length < 8) return history;
    try {
        // نأخذ الرسائل القديمة (كل ما عدا آخر 4) ونلخصها
        const toCompress = history.slice(0, -4);
        const toKeep     = history.slice(-4);
        const convText   = toCompress.map(m =>
            `${m.role === 'user' ? 'المستخدم' : 'المساعد'}: ${m.content.slice(0, 200)}`
        ).join('\n');

        const summary = await callMistral({
            model: 'mistral-small-latest', // ✅ النموذج الصحيح — open-mistral-nemo غير متاح
            messages: [
                { role: 'system', content: 'لخّص هذه المحادثة في جملتين أو ثلاث. ركّز على المواضيع الرئيسية فقط. اكتب الملخص بصيغة "تحدثنا عن..."' },
                { role: 'user', content: convText }
            ],
            max_tokens: 150,
            temperature: 0.3
        });

        console.log(`[context] ضغط: ${toCompress.length} رسالة → ملخص (${summary.length} حرف)`);
        return [
            { role: 'user',      content: `[ملخص المحادثة السابقة: ${summary}]` },
            { role: 'assistant', content: 'حسناً، أكمل معك.' },
            ...toKeep
        ];
    } catch {
        // فشل الضغط — نعود للحذف العادي
        return history.slice(-6);
    }
}

// ============================================================
// 4. كشف نوع المحادثة للسياق المتغير
// ============================================================
function detectContextNeeded(body, history) {
    if (!history || history.length === 0) return 2; // محادثة جديدة — 2 رسائل كافية
    const lastTopic = history.slice(-1)[0]?.content || '';
    // تشابه الموضوع — نستخدم سياق أطول
    const sameTopicWords = (body || '').split(' ').filter(w => w.length > 3 && lastTopic.includes(w));
    if (sameTopicWords.length >= 2) return 8;  // متابعة محادثة — 8 رسائل
    if (isComplexQuery(body))       return 10; // سؤال معقد — 10 رسائل
    return 4; // موضوع جديد — 4 رسائل
}

// ============================================================
// 5. اختيار النموذج بذكاء (3 مستويات بدل 2)
// ============================================================
function selectModel(text, historyLen) {
    // mistral-small للأسئلة البسيطة جداً (بدون سياق طبي ومحادثة قصيرة)
    // ملاحظة: open-mistral-nemo غير متاح عبر API العادي — نستخدم small كأرخص خيار متاح
    const isSimple = text.length < 80 && historyLen <= 2 && !isMedicalQuery(text) && !isComplexQuery(text);
    if (isSimple) return { model: 'mistral-small-latest', maxTok: 600 };

    const useLarge = isComplexQuery(text) || text.length > 700;
    if (useLarge) return { model: 'mistral-large-latest', maxTok: 1200 };
    return { model: 'mistral-small-latest', maxTok: 900 };
}

// ============================================================
// 6. Rate Limiting ذكي (منفصل عن checkSpam)
// ============================================================
// checkSpam يمنع الإرسال المتسارع جداً (أكثر من 3 في 5 ثوانٍ)
// هذا يضيف تأخيراً ذكياً لو المستخدم أرسل رسالتين خلال ثانية واحدة
const _lastMsgTime = {};
async function smartRateDelay(sender) {
    const now  = Date.now();
    const last = _lastMsgTime[sender] || 0;
    const diff = now - last;
    _lastMsgTime[sender] = now;

    // لو أرسل رسالتين خلال ثانية — انتظر ثانيتين قبل الإرسال لـ AI
    // هذا يمنع الإرسال المتسارع الذي يستهلك tokens بدون فائدة
    if (diff < 1000 && diff > 0) {
        console.log(`[rateDelay] ${sender} — تأخير 2 ثانية (${diff}ms بين الرسائل)`);
        await new Promise(r => setTimeout(r, 2000));
    }
}


// askAI: 3 مستويات من النماذج حسب تعقيد السؤال
// Ministral Nemo (أرخص) → Small → Large
async function askAI(messages) {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const historyLen  = messages.filter(m => m.role !== 'system').length;
    const { model, maxTok } = selectModel(lastUserMsg, historyLen);

    console.log(`[askAI] ${model} | ${lastUserMsg.length}ch | history:${historyLen}`);
    try {
        return await callMistral({ model, messages, max_tokens: maxTok, temperature: 0.5 });
    } catch (e) {
        // Fallback تصاعدي: small → large
        const fallbacks = [
            { model: 'mistral-small-latest', maxTok: 900  },
            { model: 'mistral-large-latest', maxTok: 1200 }
        ].filter(f => f.model !== model);

        for (const fb of fallbacks) {
            try {
                console.warn(`[askAI] fallback → ${fb.model}`);
                return await callMistral({ model: fb.model, messages, max_tokens: fb.maxTok, temperature: 0.5 });
            } catch (e2) {
                if (e2.message === 'AUTH_ERROR' || e2.message === 'QUOTA_ERROR') throw e2;
            }
        }
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
            max_tokens: 1500, // ✅ تقليص من 2500 → 1500 (كافٍ لتحليل PDF نصي)
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
        const q = (userQuestion || '').toLowerCase();

        // ── كشف نوع الطلب لاختيار الـ prompt المناسب ──
        const wantsTextExtract = !hasQuestion ||
            /اقرأ|استخرج|انسخ|اكتب|نص|كلام|مكتوب|نصوص|كلمات|read|extract|ocr|text|copy|transcrib/i.test(q);

        const wantsMedical =
            /أشعة|xray|x-ray|mri|رنين|ct|سكانر|تحليل دم|فحص دم|تقرير طبي|مختبر|lab|blood|صورة طبية|صورة صدر|ecg|ekg|echo|سونار|ultrasound|نتائج|results/i.test(q) ||
            isMedicalImage(userQuestion || '');

        const wantsTable =
            /جدول|table|بيانات|data|إحصاء|احصاء|أرقام|numbers|excel|spreadsheet/i.test(q);

        // ── System Prompt مخصص لكل نوع ──
        let systemPrompt;
        let userPrompt;
        let maxTok;

        if (wantsTextExtract && !hasQuestion) {
            // صورة بدون سؤال — استخراج شامل ودقيق
            systemPrompt =
                `أنت نظام OCR + تحليل صور متخصص وعالي الدقة.\n` +
                `مهمتك الأساسية: قراءة كل نص في الصورة بدقة 100% كما هو مكتوب.\n` +
                `قواعد صارمة:\n` +
                `• اقرأ كل حرف وكلمة ورقم كما هي — لا تغيّر أي شيء\n` +
                `• اقرأ النصوص العربية من اليمين لليسار بدقة\n` +
                `• اقرأ الأرقام والتواريخ والرموز كما هي تماماً\n` +
                `• إذا في جداول: حافظ على هيكلها\n` +
                `• بعد النص: أضف تحليلاً مختصراً لما تعنيه الصورة`;
            userPrompt = `اقرأ كل النصوص في هذه الصورة بدقة كاملة ثم حللها.`;
            maxTok = 2000;

        } else if (wantsMedical) {
            // صورة طبية — تحليل طبي متخصص
            systemPrompt =
                `أنت طبيب متخصص وخبير في تحليل الصور الطبية.\n` +
                `اتبع هذا الترتيب:\n` +
                `1. نوع الصورة/الفحص\n` +
                `2. قراءة كل الأرقام والقيم والنصوص الموجودة بدقة\n` +
                `3. مقارنة القيم بالمعدلات الطبيعية (اذكر المعدل الطبيعي لكل قيمة)\n` +
                `4. الملاحظات السريرية المهمة\n` +
                `5. التوصية المقترحة\n` +
                `قواعد:\n` +
                `• اقرأ الأرقام بدقة 100% — خطأ في رقم = خطأ طبي\n` +
                `• وضّح بوضوح: هل القيمة طبيعية ✅ أم غير طبيعية ⚠️\n` +
                `• لا جداول، نص طبيعي فقط\n` +
                `• اختم دائماً بـ: تنبيه: راجع طبيبك للتشخيص النهائي`;
            userPrompt = hasQuestion
                ? userQuestion
                : `حلّل هذه الصورة الطبية بالتفصيل الكامل مع قراءة كل القيم والأرقام بدقة.`;
            maxTok = 2000;

        } else if (wantsTable) {
            // جدول أو بيانات — قراءة منظمة
            systemPrompt =
                `أنت خبير في قراءة الجداول والبيانات من الصور.\n` +
                `قواعد:\n` +
                `• اقرأ كل خلية في الجدول بدقة كاملة\n` +
                `• حافظ على ترتيب الصفوف والأعمدة\n` +
                `• اقرأ الأرقام والنصوص كما هي بدون تغيير\n` +
                `• بعد الجدول: أضف ملاحظة مختصرة عن أهم البيانات`;
            userPrompt = hasQuestion
                ? userQuestion
                : `اقرأ الجدول/البيانات في هذه الصورة بدقة كاملة.`;
            maxTok = 2000;

        } else if (hasQuestion) {
            // سؤال محدد على الصورة — أجب على السؤال مع استخراج النص المرتبط
            systemPrompt =
                `أنت مساعد ذكي متخصص في تحليل الصور والإجابة على الأسئلة المتعلقة بها.\n` +
                `قواعد:\n` +
                `• اقرأ النصوص والأرقام في الصورة بدقة كاملة\n` +
                `• أجب على سؤال المستخدم مباشرة بناءً على ما تراه\n` +
                `• إذا السؤال يتعلق بنص في الصورة: اقتبسه بدقة\n` +
                `• لا تستنتج ما لا تراه فعلاً في الصورة\n` +
                `• اللغة: نفس لغة السؤال`;
            userPrompt = hasQuestion ? userQuestion : '';
            maxTok = 1500;

        } else {
            // صورة عادية بدون سؤال — وصف شامل
            systemPrompt =
                `أنت مساعد ذكي متخصص في وصف وتحليل الصور.\n` +
                `قواعد:\n` +
                `• صف ما تراه في الصورة بشكل كامل ودقيق\n` +
                `• إذا في نصوص أو أرقام: اقرأها بدقة كما هي\n` +
                `• إذا في أشخاص أو أشياء: صفها\n` +
                `• إذا في مشهد أو مكان: اشرحه\n` +
                `• الرد باللغة العربية`;
            userPrompt = `صف هذه الصورة بالتفصيل الكامل.`;
            maxTok = 1500;
        }

        const namePrefix = userName ? `(المستخدم: ${userName})\n` : '';

        return await callMistral({
            model: 'pixtral-large-latest',
            messages: [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:${mime};base64,${base64Image}`,
                                detail: 'high'  // ✅ دقة عالية — أهم تعديل لاستخراج النص بدقة
                            }
                        },
                        { type: 'text', text: namePrefix + userPrompt }
                    ]
                }
            ],
            max_tokens: maxTok,
            temperature: 0.1  // ✅ temperature منخفضة جداً = دقة أعلى في قراءة النصوص
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
            `*🔊 ميزات الصوت:*\n` +
            `• *نطق [جملة أو فقرة]* — تحويل أي نص لصوت (بدون حد للطول)\n` +
            `• *صوت [نص]* — نفس أمر النطق\n` +
            `• أرسل رسالة صوتية — البوت يفهمها ويرد عليها\n` +
            `• أرسل رسالة صوتية مع caption *!نص* — يستخرج النص فقط\n` +
            `• أرسل رسالة صوتية مع caption *رد بصوت* — يرد صوتياً\n\n` +
            `*📄 ميزات الملفات:*\n` +
            `• أرسل ملف PDF — يفعّل وضع الملف تلقائياً\n` +
            `• *صفحة [رقم]* — شرح صفحة معينة\n` +
            `• *ملخص* — ملخص الملف\n` +
            `• *خروج* — الخروج من وضع الملف\n\n` +
            `_يمكنك إرسال الصور للتحليل أو قراءة النص_\n` +
            `_لطلب ترجمة: اكتب "ترجم [النص]"_`
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
            await reply('♾️ *رصيدك غير محدود* (VIP/أدمن)\n\n💬 رسائل: ♾️\n🖼️ صور: ♾️\n🔊 صوت/ترجمة: ♾️\n📄 PDF: ♾️ بلا حد للحجم');
        } else {
            const limit    = getUserDailyLimit(sender);
            const rec      = getDailyRecord(sender);
            const msgUsed  = rec.messages || 0;
            const imgUsed  = rec.images   || 0;
            const ttsUsed  = rec.tts      || 0;
            const msgLeft  = Math.max(0, limit - msgUsed);
            const imgLeft  = Math.max(0, DAILY_IMG_LIMIT - imgUsed);
            const ttsLeft  = Math.max(0, DAILY_TTS_LIMIT - ttsUsed);
            await reply(
                `📊 *رصيدك — النسخة المجانية (غير متجدد):*\n\n` +
                `💬 الرسائل النصية:    ${msgUsed}/${limit} — متبقي: *${msgLeft}*\n` +
                `🖼️ الصور المحللة:     ${imgUsed}/${DAILY_IMG_LIMIT} — متبقي: *${imgLeft}*\n` +
                `🔊 الرسائل الصوتية:  ${ttsUsed}/${DAILY_TTS_LIMIT} — متبقي: *${ttsLeft}*\n` +
                `📄 PDF:              حد الحجم 1MB فقط\n\n` +
                `⚠️ هذا الرصيد لمرة واحدة فقط ولا يتجدد تلقائياً.\n\n` +
                `─────────────\n` +
                `💎 *النسخة المميزة (VIP):*\n` +
                `✅ رسائل + صور + صوت: ♾️ غير محدود\n` +
                `✅ PDF: بدون حد للحجم\n` +
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
    if (!isConnected) { console.log("[broadcast] البوت غير متصل"); return { sent: 0, failed: 0, total: 0 }; }
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
            console.log(`📤 إرسال لـ ${num}`);
            // ملاحظة: Cloud API يسمح بالرد المجاني فقط ضمن نافذة 24 ساعة من آخر رسالة من المستخدم.
            // إذا تجاوز المستخدم 24 ساعة بدون تفاعل، يجب استخدام Message Template معتمد من Meta.
            await wa.sendText(num, text);
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
// WEB SERVER — لوحة التحكم + Webhook الرسمي لـ WhatsApp Cloud API
// ============================================================
function startWebServer() {
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

        // ============================================================
        // ===== WEBHOOK (Meta) — معالجة فورية، بدون rate-limit أو جلسة =====
        // ============================================================
        if (url === '/webhook' && req.method === 'GET') {
            const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
            const mode      = parsedUrl.searchParams.get('hub.mode');
            const token     = parsedUrl.searchParams.get('hub.verify_token');
            const challenge = parsedUrl.searchParams.get('hub.challenge');

            if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                console.log('✅ تم التحقق من Webhook بنجاح');
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(challenge || '');
            } else {
                console.warn('⚠️ فشل التحقق من Webhook (verify_token غير مطابق)');
                res.writeHead(403);
                res.end();
            }
            return;
        }

        if (url === '/webhook' && req.method === 'POST') {
            let rawBody = '';
            req.on('data', d => rawBody += d);
            req.on('end', async () => {
                // الرد فوراً بـ 200 — وإلا تعيد Meta إرسال نفس الحدث
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{"status":"ok"}');

                try {
                    const payload = JSON.parse(rawBody || '{}');
                    const entry  = payload?.entry?.[0];
                    const change = entry?.changes?.[0];
                    const value  = change?.value;
                    if (!value) return;

                    // تجاهل تحديثات الحالة (delivered/read/sent)
                    if (value.statuses) return;

                    const messages = value.messages;
                    if (!messages || !messages.length) return;

                    for (const m of messages) {
                        try {
                            const adapted = adaptCloudMessage(m, value);
                            // تعليم كمقروءة (best-effort)
                            wa.markAsRead(m.id).catch(() => {});
                            await processIncomingMessage(adapted);
                        } catch (e) {
                            console.error('[webhook message]', e.message);
                        }
                    }
                } catch (e) {
                    console.error('[webhook]', e.message);
                }
            });
            return;
        }

        // ============================================================
        // ===== لوحة التحكم (Dashboard) — محمية بـ rate-limit + جلسة =====
        // ============================================================
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
                            'Set-Cookie': `adm_tok=${token}; Path=/; HttpOnly; Max-Age=43200; SameSite=Lax`,
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
            if (url === '/api' || url === '/data') {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, msg: 'Unauthorized' }));
            } else {
                res.writeHead(302, { 'Location': '/login' });
                res.end();
            }
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
                        const num = String(data.num || '').replace(/\D/g, '').trim();
                        if (!num) { result = { ok: false, msg: 'رقم الهاتف غير صحيح' }; }
                        else if (!vipNumbers.includes(num)) {
                            vipNumbers.push(num);
                            const expiry = Date.now() + 30 * 24 * 60 * 60_000;
                            vipExpiry[num] = expiry;
                            resetUserUsage(num);
                            saveData();
                            if (isConnected) {
                                try {
                                    const expDate = new Date(expiry).toLocaleDateString('ar-SA');
                                    await wa.sendText(num,
                                            `🌟 *تهانينا! تم تفعيل اشتراكك المميز (VIP)*\n\n` +
                                            `✅ *صلاحياتك الآن غير محدودة:*\n` +
                                            `💬 رسائل: ♾️ غير محدودة\n` +
                                            `🖼️ صور: ♾️ غير محدودة\n` +
                                            `🔊 صوت وترجمة: ♾️ غير محدودة\n` +
                                            `📄 ملفات PDF: ♾️ بدون حد للحجم\n\n` +
                                            `📅 تاريخ الانتهاء: ${expDate}\n\n` +
                                            `شكراً لثقتك بنا! 🎉`
                                    );
                                } catch (_) {}
                            }
                            result.msg = `✅ تم تفعيل VIP للمستخدم ${num} لمدة شهر`;
                        } else {
                            // تجديد — إضافة شهر من الآن أو من تاريخ الانتهاء الحالي أيهما أبعد
                            const current = vipExpiry[num] || Date.now();
                            vipExpiry[num] = Math.max(current, Date.now()) + 30 * 24 * 60 * 60_000;
                            saveData();
                            if (isConnected) {
                                try {
                                    const expDate = new Date(vipExpiry[num]).toLocaleDateString('ar-SA');
                                    await wa.sendText(num, `🔄 *تم تجديد اشتراكك المميز (VIP)*\n📅 الانتهاء الجديد: ${expDate}\nشكراً لثقتك بنا! 🌟`);
                                } catch (_) {}
                            }
                            result.msg = `✅ تم تجديد VIP للمستخدم ${num} لشهر إضافي`;
                        }
                    }
                    else if (action === 'removeVip') {
                        const num = String(data.num || '').replace(/\D/g, '').trim();
                        if (!num) { result = { ok: false, msg: 'رقم الهاتف غير صحيح' }; }
                        else {
                            const wasVip = vipNumbers.includes(num);
                            vipNumbers = vipNumbers.filter(n => n !== num);
                            delete vipExpiry[num];
                            saveData();
                            if (wasVip && isConnected) {
                                try {
                                    await wa.sendText(num, `ℹ️ تم إلغاء اشتراكك المميز (VIP).\nيمكنك التجديد عبر التواصل معنا:\n👤 wa.me/972593850520`);
                                } catch (_) {}
                            }
                            result.msg = wasVip ? `✅ تم إزالة VIP عن ${num}` : `المستخدم ${num} لم يكن VIP`;
                        }
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
                        const num = String(data.num || '').replace(/\D/g, '').trim();
                        if (!num) { result = { ok: false, msg: 'رقم الهاتف غير صحيح' }; }
                        else if (blacklist.includes(num)) {
                            result.msg = `المستخدم ${num} محظور مسبقاً`;
                        } else {
                            blacklist.push(num);
                            saveData();
                            if (isConnected) {
                                try {
                                    await wa.sendText(num, BLACKLIST_MSG);
                                } catch (_) {}
                            }
                            result.msg = `✅ تم حظر ${num} وإرسال إشعار`;
                        }
                    }
                    else if (action === 'removeBlacklist') {
                        const num = String(data.num || '').replace(/\D/g, '').trim();
                        if (!num) { result = { ok: false, msg: 'رقم الهاتف غير صحيح' }; }
                        else {
                            const wasBlocked = blacklist.includes(num);
                            blacklist = blacklist.filter(n => n !== num);
                            saveData();
                            result.msg = wasBlocked ? `✅ تم رفع الحظر عن ${num}` : `المستخدم ${num} لم يكن محظوراً`;
                        }
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
                            resetUserUsage(num); // تصفير الاستهلاك عند رفع الحد
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
                            if (isConnected && limit > oldLimit) {
                                try {
                                    const name = userNames[num] ? `${userNames[num]}` : '';
                                    const msg = nowAllowed
                                        ? `🎉 ${name ? `أهلاً ${name}، ` : ''}تم رفع حد رسائلك اليومي إلى *${limit}* رسالة!\n\nيمكنك الآن الاستمرار في المحادثة. 🚀`
                                        : `ℹ️ ${name ? `${name}، ` : ''}تم تعديل حدك اليومي إلى *${limit}* رسالة.\n\nللحصول على المزيد تواصل مع الأدمن أو اشترك بـ VIP`;
                                    await wa.sendText(num, msg);
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
                const rec = userLimitsUsage[cleanNum];
                const limit = getUserDailyLimit(cleanNum);
                userUsage[cleanNum] = {
                    used: rec ? rec.messages : 0,
                    images: rec ? rec.images : 0,
                    docs: rec ? rec.docs : 0,
                    limit,
                    remaining: Math.max(0, limit - (rec ? rec.messages : 0)),
                    resetAt: rec ? rec.activatedAt : null
                };
            }
            const d = {
                connected: isConnected,
                hasQR: false, // لا يوجد مفهوم QR في WhatsApp Cloud API — البوت متصل دائماً عبر HTTP
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

// دالة تقسيم الرسائل الطويلة — معرّفة خارج الـ loop لتجنب إعادة التعريف مع كل رسالة
const WA_CHUNK_LIMIT = 3800;
function splitMessage(text) {
    if (!text || text.length <= WA_CHUNK_LIMIT) return [text || ''];
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


function buildWelcome(name) {
    return buildModeMenu(name);
}

// ============================================================
// TRANSLATION — Google Translate (مجاني) مع Fallback تلقائي لـ Mistral
// 3 مراحل: Google → MyMemory → Mistral (fallback أخير)
// ============================================================
async function smartTranslate(text, targetLangCode) {
    // ── المرحلة 1: Google Translate ──
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLangCode}&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetchWithTimeout(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }, 8_000);
        if (res.ok) {
            const data = await res.json();
            const translated = data?.[0]?.filter(Boolean)?.map(item => item?.[0])?.filter(Boolean)?.join('') || '';
            if (translated.trim()) {
                console.log('[translate] Google ✅');
                return { text: translated.trim(), source: 'google' };
            }
        }
        throw new Error(`Google HTTP ${res.status}`);
    } catch (e) {
        console.warn('[translate] Google فشل:', e.message, '← جاري تجربة MyMemory...');
    }

    // ── المرحلة 2: MyMemory API ──
    try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${targetLangCode}`;
        const res = await fetchWithTimeout(url, {}, 8_000);
        if (res.ok) {
            const data = await res.json();
            const translated = data?.responseData?.translatedText || '';
            if (translated && !translated.startsWith('MYMEMORY') && translated.trim()) {
                console.log('[translate] MyMemory ✅');
                return { text: translated.trim(), source: 'mymemory' };
            }
        }
        throw new Error(`MyMemory HTTP ${res.status}`);
    } catch (e) {
        console.warn('[translate] MyMemory فشل:', e.message, '← رجوع لـ Mistral...');
    }

    // ── المرحلة 3: Mistral AI (fallback أخير) ──
    try {
        const targetLangName = targetLangCode === 'ar' ? 'العربية' : 'English';
        const translated = await callMistral({
            model: 'mistral-small-latest',
            messages: [
                { role: 'system', content: `أنت مترجم محترف. ترجم النص إلى ${targetLangName}. أرسل الترجمة فقط بدون أي شرح.` },
                { role: 'user', content: text }
            ],
            max_tokens: 500,
            temperature: 0.3
        });
        console.log('[translate] Mistral ✅ (fallback)');
        return { text: translated.trim(), source: 'mistral' };
    } catch (e) {
        console.error('[translate] Mistral فشل أيضاً:', e.message);
        throw new Error('فشلت كل خدمات الترجمة');
    }
}

// ============================================================
// MAIN BOT
// ============================================================
// ============================================================
// تشغيل البوت — WhatsApp Cloud API (Webhook)
// كل رسالة واردة من Express webhook تُمرَّر هنا بصيغة Baileys-like
// عبر adaptCloudMessage() الموجودة في cloudAdapter.js — حتى يبقى كل المنطق أدناه بدون تغيير
// ============================================================
async function startBot() {
    isConnected = true;
    console.log('✅ البوت متصل عبر WhatsApp Cloud API وجاهز!');
}

// تُستدعى من bot.js (Express) لكل رسالة واردة من الـ Webhook
// adaptedMsg: كائن بصيغة Baileys-like تم بناؤه بواسطة adaptCloudMessage()
async function processIncomingMessage(adaptedMsg) {
        const msgList = [adaptedMsg];

        for (const msg of msgList) {
        if (!msg?.message || msg?.key?.fromMe) continue;
        // تجاهل الرسائل القديمة أكثر من 10 دقائق
        const msgTs = (msg.messageTimestamp || 0) * 1000;
        if (Date.now() - msgTs > 10 * 60 * 1000) continue;

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
            if (!sender) continue;

            const isAdmin = sender === ADMIN_NUMBER;
            userChatLastSeen[sender] = Date.now(); // تحديث آخر نشاط

            const reply = async (text) => {
                try {
                    // ✅ طبقة أمان: حذف النجوم من أي رد قبل الإرسال
                    const clean = (text||'').replace(/\*([^*\n]+)\*/g, '$1');
                    const parts = splitMessage(clean);
                    if (parts.length === 1) {
                        await wa.sendReply(sender, parts[0], msg.key.id);
                    } else {
                        await wa.sendReply(sender, parts[0], msg.key.id);
                        for (let i = 1; i < parts.length; i++) {
                            await new Promise(r => setTimeout(r, 500));
                            await wa.sendText(sender, parts[i]);
                        }
                    }
                } catch (e) {
                    console.error('[reply] خطأ:', e.message);
                }
            };

            const react = async (emoji) => {
                try {
                    await wa.sendReaction(sender, msg.key.id, emoji);
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
            // ============================================================
    // أوامر الأدمن عبر واتساب (تعمل من رقم الأدمن فقط)
    // ============================================================
    if (isAdmin) {
        // !removevip [رقم]
        const removeVipMatch = body.match(/^!removevip\s+(\d+)/i);
        if (removeVipMatch) {
            const num = removeVipMatch[1].trim();
            const wasVip = vipNumbers.includes(num);
            vipNumbers = vipNumbers.filter(n => n !== num);
            delete vipExpiry[num];
            saveData();
            if (wasVip && isConnected) {
                try { await wa.sendText(num, `ℹ️ تم إلغاء اشتراكك المميز (VIP).\nللتجديد: wa.me/972593850520`); } catch (_) {}
            }
            await reply(wasVip ? `✅ تم إزالة VIP عن ${num} وتم إشعاره.` : `⚠️ الرقم ${num} لم يكن VIP أصلاً.`);
            return true;
        }
        // !addvip [رقم]
        const addVipMatch = body.match(/^!addvip\s+(\d+)/i);
        if (addVipMatch) {
            const num = addVipMatch[1].trim();
            if (!vipNumbers.includes(num)) {
                vipNumbers.push(num);
                vipExpiry[num] = Date.now() + 30 * 24 * 60 * 60_000;
                resetUserUsage(num);
                saveData();
                try { await wa.sendText(num, `🌟 *تهانينا! تم تفعيل اشتراكك المميز (VIP)*\nرسائل وصور وصوت غير محدودة ✨`); } catch (_) {}
                await reply(`✅ تم تفعيل VIP للرقم ${num} لمدة شهر.`);
            } else {
                await reply(`⚠️ الرقم ${num} VIP أصلاً.`);
            }
            return true;
        }
        // !resetlimit [رقم]
        const resetLimitMatch = body.match(/^!resetlimit\s+(\d+)/i);
        if (resetLimitMatch) {
            const num = resetLimitMatch[1].trim();
            resetUserUsage(num);
            await reply(`✅ تم تصفير استهلاك ${num}.`);
            return true;
        }
    }

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
                    if (!isProcessable) continue; // ✅ continue بدل return — نكمل بقية الرسائل
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
                    const mime     = imgMsg?.mimetype || 'image/jpeg';
                    let buffer;
                    try {
                        const dl = await wa.downloadMedia(imgMsg?.id);
                        buffer = dl.buffer;
                    } catch (_) { buffer = null; }
                    if (!buffer || buffer.length === 0) {
                        await react('❌');
                        await reply('لم أتمكن من تنزيل الصورة، يرجى المحاولة مرة أخرى.');
                        return;
                    }
                    // فحص الحجم بعد التنزيل (Cloud API لا يرسل الحجم في الـ webhook)
                    if (buffer.length > 8 * 1024 * 1024) {
                        await react('❌');
                        await reply(`حجم الصورة كبير جداً (${(buffer.length/1024/1024).toFixed(1)}MB).\nالحد الأقصى 8MB.`);
                        return;
                    }
                    stats.totalImages++;
                    saveData();
                    const res = await askAIWithImage(buffer.toString('base64'), body, userName, mime);
                    // حفظ وصف الصورة في السياق
                    if (!userChats[sender]) userChats[sender] = [];
                    userChats[sender].push({ role: 'user',      content: body ? `[أرسل صورة مع رسالة: ${body}]` : '[أرسل صورة]' });
                    userChats[sender].push({ role: 'assistant', content: res });
                    // إضافة رصيد متبقي للمستخدم العادي
                    let imgFinalRes = res;
                    if (!isVIPimg) {
                        const rec2 = getDailyRecord(sender);
                        const imgLeft2  = Math.max(0, DAILY_IMG_LIMIT - (rec2.images || 0));
                        const msgLeft2  = Math.max(0, getUserDailyLimit(sender) - (rec2.messages || 0));
                        const ttsLeft2  = Math.max(0, DAILY_TTS_LIMIT - (rec2.tts || 0));
                        imgFinalRes += `\n\n─────────────\n_🖼️ صور: ${imgLeft2} | 💬 رسائل: ${msgLeft2} | 🔊 صوت: ${ttsLeft2}_`;
                    }
                    await reply(imgFinalRes);
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
                    const docMsg   = message.documentMessage;
                    const mime     = docMsg?.mimetype || '';
                    const fileName = docMsg?.fileName || 'ملف';
                    const caption  = body || '';

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

                    const isVIPpdf   = isAdmin || isActiveVIP(sender);
                    const pdfMaxSize = isVIPpdf ? 20 * 1024 * 1024 : 5 * 1024 * 1024;

                    // تنزيل الملف
                    let buffer;
                    try {
                        const dl = await wa.downloadMedia(docMsg?.id);
                        buffer = dl.buffer;
                    } catch (_) { buffer = null; }

                    if (!buffer || buffer.length === 0) {
                        await react('❌');
                        await reply('لم أتمكن من تنزيل الملف، يرجى المحاولة مرة أخرى.');
                        return;
                    }

                    // فحص الحجم بعد التنزيل
                    if (buffer.length > pdfMaxSize) {
                        await react('❌');
                        if (isVIPpdf) {
                            await reply(`حجم الملف كبير جداً (${(buffer.length/1024/1024).toFixed(1)}MB).\nالحد الأقصى 20MB. 📄`);
                        } else {
                            await reply(
                                `⚠️ حجم الملف كبير جداً (${(buffer.length/1024/1024).toFixed(1)}MB).\n` +
                                `الحد الأقصى للنسخة المجانية *5MB*.\n\n` +
                                `📌 للحصول على حد *20MB* اشترك بالنسخة المميزة:\n` +
                                `👤 wa.me/972593850520`
                            );
                        }
                        return;
                    }

                    // فحص Magic Bytes — PDF حقيقي
                    if (buffer.length < 4 || buffer.slice(0,4).toString('ascii') !== '%PDF') {
                        await react('❌');
                        await reply('الملف ليس PDF حقيقياً، يرجى إرسال ملف PDF صحيح.');
                        return;
                    }

                    // ── فحص الكاش المشترك (بين كل المستخدمين) ──
                    const cacheKey = pdfCacheKey(fileName, buffer);
                    const cacheHit = await pdfCacheGet(cacheKey);

                    if (cacheHit) {
                        // ✅ موجود في الكاش — تحميل فوري بدون استخراج
                        console.log(`[PDF] كاش موجود (مشترك): ${cacheKey}`);
                        const { docText, pageCount } = cacheHit;

                        stats.totalDocs = (stats.totalDocs || 0) + 1;
                        saveData();

                        // تفعيل وضع الملف مباشرة + حفظ السياق
                        userPdfContext[sender] = {
                            fileName,
                            docText,
                            pages: null,   // الصور غير محفوظة في الكاش، نعتمد النص
                            pageCount,
                            loadedAt: Date.now()
                        };
                        // مسح سياق المحادثة القديمة وبدء سياق جديد للملف
                        userChats[sender] = [];

                        await react('📄');
                        await reply(
                            `📄 *"${fileName}"*\n` +
                            `⚡ هذا الملف محفوظ مسبقاً في النظام (${pageCount} صفحة) — تم تحميله فوراً!\n\n` +
                            `✅ *وضع الملف مفعّل تلقائياً* — سأجيب على أسئلتك من هذا الملف.\n\n` +
                            `💡 *يمكنك:*\n` +
                            `• اسألني أي سؤال من الملف\n` +
                            `• اكتب *صفحة [رقم]* لشرح صفحة معينة (مثال: صفحة 3)\n` +
                            `• اكتب *ملخص* للحصول على ملخص الملف\n` +
                            `• اكتب *خروج* للخروج من وضع الملف`
                        );
                        return;
                    }

                    // ── الملف جديد — استخراج كامل ──
                    await reply('⏳ جاري قراءة الملف واستخراج محتواه، انتظر لحظة...');
                    console.log(`[PDF] استخراج جديد: "${fileName}"`);

                    const tmpDirName = `pdf_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
                    const tmpDir     = path.join(os.tmpdir(), tmpDirName);
                    await fs.promises.mkdir(tmpDir, { recursive: true });

                    try {
                        const pdfPath = path.join(tmpDir, 'input.pdf');
                        await fs.promises.writeFile(pdfPath, buffer);

                        // تحويل الصفحات لصور بـ mutool
                        await new Promise((resolve, reject) => {
                            execFile('mutool', [
                                'convert', '-o', path.join(tmpDir, 'page-%d.jpg'),
                                '-O', 'resolution=150', pdfPath
                            ], { timeout: 60_000 }, (err, _so, se) => {
                                if (err) return reject(new Error(`mutool: ${se || err.message}`));
                                resolve();
                            });
                        });

                        const dirEntries = await fs.promises.readdir(tmpDir);
                        const pageFiles  = dirEntries
                            .filter(f => f.startsWith('page-') && f.endsWith('.jpg'))
                            .sort();

                        if (pageFiles.length === 0) throw new Error('mutool لم ينتج أي صور');
                        console.log(`[PDF] تم تحويل ${pageFiles.length} صفحة من "${fileName}"`);

                        const pages = await Promise.all(
                            pageFiles.map(f => fs.promises.readFile(path.join(tmpDir, f)).then(b => b.toString('base64')))
                        );

                        // استخراج النص
                        let docText = '';
                        try {
                            const parsed = await pdfParse(buffer);
                            docText = (parsed.text || '').trim();
                        } catch (_) {}

                        // ── حفظ في الكاش المشترك ──
                        if (docText) await pdfCacheSet(cacheKey, fileName, docText, pageFiles.length);

                        stats.totalDocs = (stats.totalDocs || 0) + 1;
                        saveData();

                        // تفعيل وضع الملف مباشرة + حفظ السياق
                        userPdfContext[sender] = {
                            fileName,
                            docText,
                            pages,
                            pageCount: pageFiles.length,
                            loadedAt: Date.now()
                        };
                        // مسح سياق المحادثة القديمة وبدء جديد للملف
                        userChats[sender] = [];

                        await react('📄');
                        await reply(
                            `📄 *تم قراءة الملف بنجاح: "${fileName}"*\n` +
                            `(${pageFiles.length} صفحة — يقرأ النصوص والصور معاً)\n\n` +
                            `✅ *وضع الملف مفعّل تلقائياً* — سأجيب على أسئلتك من هذا الملف.\n\n` +
                            `💡 *يمكنك:*\n` +
                            `• اسألني أي سؤال من الملف\n` +
                            `• اكتب *صفحة [رقم]* لشرح صفحة معينة (مثال: صفحة 3)\n` +
                            `• اكتب *ملخص* للحصول على ملخص الملف\n` +
                            `• اكتب *خروج* للخروج من وضع الملف`
                        );

                    } catch (imgErr) {
                        console.error('[PDF]', imgErr.message);
                        await react('❌');
                        await reply(`عذراً، لم أتمكن من قراءة "${fileName}".\nتأكد أن الملف غير محمي بكلمة مرور.`);
                    } finally {
                        try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
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
                    let buffer;
                    try {
                        const dl = await wa.downloadMedia(audioMsg?.id);
                        buffer = dl.buffer;
                    } catch (_) { buffer = null; }
                    if (!buffer || buffer.length === 0) {
                        await react('❌');
                        await reply('لم أتمكن من تنزيل الرسالة الصوتية، حاول مرة أخرى.');
                        return;
                    }

                    // ✅ فحص مدة الرسالة الصوتية
                    const isVIPaudio  = isAdmin || isActiveVIP(sender);
                    const maxSeconds  = isVIPaudio ? AUDIO_MAX_SECONDS_VIP : AUDIO_MAX_SECONDS_FREE;
                    const durationSec = await getAudioDurationSeconds(buffer);

                    if (durationSec !== null && durationSec > maxSeconds) {
                        await react('⛔');
                        const maxMin = Math.floor(maxSeconds / 60);
                        const durMin = Math.floor(durationSec / 60);
                        const durSec = durationSec % 60;
                        await reply(
                            `⚠️ *الرسالة الصوتية طويلة جداً*\n\n` +
                            `مدتها: *${durMin}:${String(durSec).padStart(2,'0')} دقيقة*\n` +
                            `الحد الأقصى: *${maxMin} دقيقة* ${isVIPaudio ? '(VIP)' : '(مجاني)'}\n\n` +
                            (isVIPaudio ? '' :
                                `💎 *النسخة المميزة VIP:* حتى 15 دقيقة\n` +
                                `👤 wa.me/972593850520`)
                        );
                        return;
                    }

                    // فحص الحد اليومي للصوت
                    let ttsQuota = null;
                    if (!isAdmin && !isVIPaudio) {
                        ttsQuota = checkDailyTTS(sender);
                        if (!ttsQuota.allowed) {
                            await react('⛔');
                            await reply(`⚠️ *وصلت للحد اليومي للرسائل الصوتية* (${DAILY_TTS_LIMIT} مرات)\n\nللاشتراك المميز (غير محدود):\n👤 wa.me/972593850520`);
                            return;
                        }
                    }

                    // ✅ كشف طلب استخراج النص فقط (بدون رد من AI)
                    // المستخدم يرسل رسالة صوتية مع caption: "!نص" أو "استخرج النص" أو "حول لنص"
                    const wantsTextOnly = body && /^(?:!نص|!text|استخرج النص|حول.{0,5}نص|نص فقط|transcribe|نصّ|نص|اكتب اللي قلتو|اكتب ما قيل)$/i.test(body.trim());

                    if (wantsTextOnly) {
                        // ── استخراج النص فقط من الصوت ──
                        await reply('⏳ جاري استخراج النص من الرسالة الصوتية...');
                        const transcribed = await transcribeAndReplyAudio(
                            buffer, mime,
                            'استمع لهذه الرسالة الصوتية واكتب نصها الحرفي كاملاً بدون أي رد أو تعليق. اكتب النص فقط كما سمعته.',
                            userName,
                            [] // بدون سياق
                        );
                        await reply(`📝 *النص المستخرج:*\n\n${transcribed}`);
                        if (!isVIPaudio && ttsQuota) ttsQuota.commit?.();
                        await react('✅');

                        // حفظ في السياق
                        if (!userChats[sender]) userChats[sender] = [];
                        userChats[sender].push({ role: 'user',      content: '[طلب استخراج نص من رسالة صوتية]' });
                        userChats[sender].push({ role: 'assistant', content: transcribed });

                    } else {
                        // ── الوضع العادي: Voxtral يفهم ويرد ──
                        if (!userChats[sender]) userChats[sender] = [];
                        const res = await transcribeAndReplyAudio(
                            buffer, mime, body, userName, userChats[sender]
                        );

                        // حفظ في السياق
                        userChats[sender].push({ role: 'user',      content: body ? `[رسالة صوتية + نص: ${body}]` : '[رسالة صوتية]' });
                        userChats[sender].push({ role: 'assistant', content: res });

                        stats.totalMessages++;
                        saveData();

                        // إضافة رصيد متبقي للمستخدم العادي
                        let audioFinalRes = `🎙️ ${res}`;
                        if (!isVIPaudio) {
                            const rec3 = getDailyRecord(sender);
                            const ttsLeft3 = Math.max(0, DAILY_TTS_LIMIT - (rec3.tts || 0));
                            const msgLeft3 = Math.max(0, getUserDailyLimit(sender) - (rec3.messages || 0));
                            const imgLeft3 = Math.max(0, DAILY_IMG_LIMIT - (rec3.images || 0));
                            audioFinalRes += `\n\n─────────────\n_🔊 صوت: ${ttsLeft3} | 💬 رسائل: ${msgLeft3} | 🖼️ صور: ${imgLeft3}_`;
                        }
                        await reply(audioFinalRes);

                        // ✅ ميزة جديدة: إرسال الرد صوتياً إذا طلب المستخدم
                        // caption يحتوي "رد صوت" أو "صوتي" أو "بصوت"
                        const wantsVoiceReply = body && /رد صوت|رد بصوت|صوتي|بصوت|voice reply|voice/i.test(body);
                        if (wantsVoiceReply) {
                            try {
                                const replyLang = /[\u0600-\u06FF]/.test(res) ? 'ar' : 'en';
                                const replyAudio = await generateTTS(res, replyLang);
                                await sendVoiceNote(jid, replyAudio);
                            } catch (_) {} // فشل TTS لا يوقف البوت
                        }

                        if (!isVIPaudio && ttsQuota) ttsQuota.commit?.();
                        await react('✅');
                    }

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
            if (!body) continue; // ✅ continue بدل return — نكمل بقية الرسائل

            // ============================================================
            // كشف "نعم" لإرسال النطق الصوتي (TTS)
            // إذا كان المستخدم في انتظار نطق مصطلح أو دواء وأرسل "نعم"
            // ============================================================
            const bodyTrimmed = body.trim();

            // ============================================================
            // وضع PDF النشط — الإجابة من الملف مع حفظ السياق
            // ============================================================
            if (userPdfContext[sender]) {
                const { fileName, docText, pages, pageCount } = userPdfContext[sender];

                // خروج من وضع الملف
                if (/^خروج$/i.test(bodyTrimmed)) {
                    delete userPdfContext[sender];
                    userChats[sender] = [];
                    await react('✅');
                    await reply('تم الخروج من وضع الملف. يمكنك الآن إرسال أي سؤال بشكل عادي. 👋');
                    return;
                }

                // رجوع للقائمة الرئيسية
                if (/^قائمة$/i.test(bodyTrimmed)) {
                    delete userPdfContext[sender];
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
                    // ── طلب شرح صفحة معينة — "صفحة 3" أو "page 3" ──
                    const pageMatch = bodyTrimmed.match(/^(?:صفحة|page)\s*(\d+)$/i);
                    if (pageMatch) {
                        const pageNum = parseInt(pageMatch[1], 10);
                        const totalPages = pageCount || (pages ? pages.length : 0);

                        if (pageNum < 1 || (totalPages > 0 && pageNum > totalPages)) {
                            await react('❌');
                            await reply(`❌ رقم الصفحة غير صحيح.\nالملف يحتوي على ${totalPages} صفحة فقط.`);
                            return;
                        }

                        let res;
                        if (pages && pages[pageNum - 1]) {
                            // شرح الصفحة بالصورة (أدق)
                            res = await callMistral({
                                model: 'pixtral-large-latest',
                                messages: [
                                    { role: 'system', content: `أنت مساعد ذكي يشرح محتوى صفحات الملف: "${fileName}".\nاشرح كل ما في الصفحة بشكل واضح ومنظم باللغة العربية.` },
                                    { role: 'user', content: [
                                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${pages[pageNum - 1]}` } },
                                        { type: 'text', text: `اشرح محتوى هذه الصفحة (${pageNum}) بالتفصيل.` }
                                    ]}
                                ],
                                max_tokens: 1200, // ✅ تقليص من 2000 → 1200
                                temperature: 0.3
                            });
                        } else {
                            // شرح من النص — ✅ نقطع نص الصفحة بحد أقصى 3000 حرف (كافٍ لصفحة واحدة)
                            const charsPerPage = Math.ceil(Math.min(docText.length, 10000) / (totalPages || 1));
                            const start = (pageNum - 1) * charsPerPage;
                            const pageText = docText.slice(start, start + charsPerPage);
                            res = await callMistral({
                                model: 'mistral-large-latest', // ✅ نص — لا حاجة لـ pixtral
                                messages: [
                                    { role: 'system', content: `أنت مساعد ذكي يشرح محتوى صفحات الملف: "${fileName}". اشرح بوضوح باللغة العربية.` },
                                    { role: 'user', content: `اشرح محتوى الصفحة ${pageNum}:\n${pageText}` }
                                ],
                                max_tokens: 1000, // ✅ شرح صفحة واحدة لا يحتاج أكثر
                                temperature: 0.3
                            });
                        }

                        // حفظ في سياق المحادثة
                        if (!userChats[sender]) userChats[sender] = [];
                        userChats[sender].push({ role: 'user',      content: `[طلب شرح صفحة ${pageNum} من "${fileName}"]` });
                        userChats[sender].push({ role: 'assistant', content: res });
                        if (userChats[sender].length > MAX_HISTORY) userChats[sender] = userChats[sender].slice(-MAX_HISTORY);

                        await reply(`📄 *شرح الصفحة ${pageNum} من "${fileName}":*\n\n${res}`);
                        await react('✅');
                        return;
                    }

                    // ── طلب ملخص الملف ──
                    if (/^ملخص$|^summarize$|^summary$/i.test(bodyTrimmed)) {
                        let res;
                        // ✅ تحسين: استخدام النص بشكل افتراضي للملخص — أرخص بكثير من الصور
                        // الصور فقط إذا لم يكن هناك نص مستخرج
                        if (docText && docText.length > 200) {
                            res = await callMistral({
                                model: 'mistral-large-latest', // نص — لا حاجة لـ pixtral
                                messages: [
                                    { role: 'system', content: `أنت مساعد ذكي. قدّم ملخصاً شاملاً ومنظماً للملف: "${fileName}" باللغة العربية.` },
                                    { role: 'user', content: `محتوى الملف:\n${docText.slice(0, 12000)}\n\nقدّم ملخصاً شاملاً ومنظماً (${pageCount} صفحة).` }
                                ],
                                max_tokens: 1500, // ✅ تقليص من 2500 → 1500
                                temperature: 0.3
                            });
                        } else if (pages && pages.length > 0) {
                            // fallback للصور فقط إذا لا يوجد نص (ملفات صور بحتة)
                            // ✅ أول 4 صفحات بدل 8 (توفير 50% على الصور)
                            const samplePages = pages.slice(0, 4);
                            const imageContents = samplePages.map(b64 => ({
                                type: 'image_url',
                                image_url: { url: `data:image/jpeg;base64,${b64}` }
                            }));
                            res = await callMistral({
                                model: 'pixtral-large-latest',
                                messages: [
                                    { role: 'system', content: `أنت مساعد ذكي. قدّم ملخصاً شاملاً للملف: "${fileName}" باللغة العربية.` },
                                    { role: 'user', content: [...imageContents, { type: 'text', text: `قدّم ملخصاً شاملاً لهذا الملف (${pageCount} صفحة).` }] }
                                ],
                                max_tokens: 1500, // ✅ تقليص من 2500 → 1500
                                temperature: 0.3
                            });
                        } else {
                            res = 'لا يوجد محتوى كافٍ لتلخيصه.';
                        }

                        if (!userChats[sender]) userChats[sender] = [];
                        userChats[sender].push({ role: 'user',      content: `[طلب ملخص الملف: "${fileName}"]` });
                        userChats[sender].push({ role: 'assistant', content: res });
                        if (userChats[sender].length > MAX_HISTORY) userChats[sender] = userChats[sender].slice(-MAX_HISTORY);

                        await reply(`📋 *ملخص "${fileName}":*\n\n${res}`);
                        await react('✅');
                        return;
                    }

                    // ── سؤال عام أو طلب حل مسألة من الملف ──
                    // ✅ تحسين الاستهلاك: استخدام النص بشكل افتراضي بدل الصور
                    // الصور (pixtral) تُستخدم فقط إذا طلب المستخدم صراحةً شيئاً يحتاج رؤية بصرية
                    // (رسم، مخطط، جدول، صورة) — هذا يوفر 80-90% من تكلفة أسئلة PDF
                    const needsVisual = /رسم|مخطط|صورة|جدول|diagram|chart|image|figure|شكل رقم|انظر الشكل/i.test(body);

                    const pdfSystemPrompt =
                        `أنت مساعد ذكي متخصص في تحليل محتوى الملف: "${fileName}".\n` +
                        `أسلوبك طبيعي ومرن — اشرح وحلّل وأجب كما يفهم الإنسان.\n` +
                        `اللغة: أجب بنفس لغة سؤال المستخدم (عربي أو إنجليزي).\n` +
                        `إذا طُلب منك حل سؤال أو مسألة: اشرح الحل خطوة بخطوة.\n` +
                        `إذا سأل عن شيء غير موجود في الملف: أخبره بلطف.`;

                    if (!userChats[sender]) userChats[sender] = [];
                    const history = userChats[sender].slice(-8); // ✅ آخر 8 رسائل للسياق (بدل 10)

                    let res;
                    if (needsVisual && pages && pages.length > 0) {
                        // ✅ الصور فقط عند الحاجة الفعلية لرؤية مخططات/رسومات
                        // ✅ إرسال صفحتين كحد أقصى بدل كل الصفحات (توفير ضخم)
                        const pagesToSend = pages.slice(0, 2);
                        const imageContents = pagesToSend.map(b64 => ({
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${b64}` }
                        }));
                        res = await callMistral({
                            model: 'pixtral-large-latest',
                            messages: [
                                { role: 'system', content: pdfSystemPrompt },
                                ...history,
                                { role: 'user', content: [...imageContents, { type: 'text', text: body }] }
                            ],
                            max_tokens: 1500, // ✅ تقليص من 2500 → 1500
                            temperature: 0.3
                        });
                    } else {
                        // ✅ النص الافتراضي للأسئلة العادية — أرخص بكثير من الصور
                        // نقطع النص لـ 12000 حرف بدل 14000 (توفير إضافي)
                        const textSnippet = docText
                            ? docText.slice(0, 12000)
                            : 'محتوى الملف غير متوفر كنص، أرسل سؤالك وسأحاول الإجابة من الذاكرة.';
                        res = await callMistral({
                            model: 'mistral-large-latest', // نص فقط — لا حاجة لـ pixtral
                            messages: [
                                { role: 'system', content: pdfSystemPrompt },
                                ...history,
                                { role: 'user', content: `محتوى الملف:\n${textSnippet}\n\nسؤال المستخدم: ${body}` }
                            ],
                            max_tokens: 1200, // ✅ تقليص من 2500 → 1200
                            temperature: 0.3
                        });
                    }

                    // حفظ في سياق المحادثة
                    userChats[sender].push({ role: 'user',      content: body });
                    userChats[sender].push({ role: 'assistant', content: res });
                    if (userChats[sender].length > MAX_HISTORY) userChats[sender] = userChats[sender].slice(-MAX_HISTORY);

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
            if (handledCmd) continue; // ✅ continue بدل return

            // ============================================================
            // كشف طلب النطق الصوتي: "نطق [كلمة/جملة]"
            // ============================================================
            const ttsMatch = bodyTrimmed.match(/^(?:نطق|صوت|اسمعني|اقرأ|نطقها?|ارسل صوت|حولها? صوت|بصوت|اقرأها?|قرأ|قراءة|حول(?:ي|وا|)? (?:لـ?|إلى )?صوت)\s+(.+)$/is)
                          || (bodyTrimmed.startsWith('صوت ') ? { 1: bodyTrimmed.slice(4) } : null);
            if (ttsMatch) {
                const isVIPnow = isActiveVIP(sender);
                let ttsCheck = null;
                if (!isAdmin && !isVIPnow) {
                    ttsCheck = checkDailyTTS(sender);
                    if (!ttsCheck.allowed) {
                        await reply(
                            `⚠️ *وصلت للحد اليومي للصوت* (${DAILY_TTS_LIMIT} مرات)\n\n` +
                            `للاشتراك المميز (غير محدود):\n👤 wa.me/972593850520`
                        );
                        return;
                    }
                }
                const ttsText = ttsMatch[1].trim();

                // ✅ لا يوجد حد للنص — جملة أو فقرة أو صفحة كاملة
                // النص يُقسَّم تلقائياً ويُدمج بملف صوتي واحد
                if (ttsText.length > 5000) {
                    await reply('⚠️ النص طويل جداً (أكثر من 5000 حرف). أرسل جزءاً أصغر.');
                    return;
                }

                await react('🔊');
                // إذا النص أكثر من 200 حرف أرسل رسالة انتظار
                if (ttsText.length > 200) {
                    await reply('⏳ جاري تحويل النص لصوت، انتظر لحظة...');
                }
                try {
                    const lang = /[\u0600-\u06FF]/.test(ttsText) ? 'ar' : 'en';
                    const audio = await generateTTS(ttsText, lang);
                    await sendVoiceNote(jid, audio, msg);
                    if (!isAdmin && !isVIPnow && ttsCheck) ttsCheck.commit?.();
                    await react('✅');
                } catch (e) {
                    console.error('[TTS]', e.message);
                    await react('❌');
                    await reply('عذراً، لم أتمكن من توليد الصوت حالياً. حاول مرة أخرى لاحقاً. 🔇');
                }
                return;
            }

            // كشف طلب الترجمة: "ترجم [نص]" — يرسل الترجمة + صوت تلقائياً
            // ============================================================
            const translateMatch = bodyTrimmed.match(/^(?:ترجم|translate|ترجمة)\s+(.+)$/i);
            if (translateMatch) {
                const isVIPnow = isActiveVIP(sender);
                const textToTranslate = translateMatch[1].trim();
                await react('⏳');
                try {
                    // تحديد لغة الهدف
                    const isArabic = /[\u0600-\u06FF]/.test(textToTranslate);
                    const targetLangCode = isArabic ? 'en' : 'ar';
                    const originalLabel  = isArabic ? '🇸🇦 الأصلي:'   : '🔤 Original:';
                    const translatedLabel = isArabic ? '🇬🇧 الترجمة:' : '🇸🇦 الترجمة:';

                    // ✅ Google Translate → MyMemory → Mistral (fallback تلقائي)
                    const result = await smartTranslate(textToTranslate, targetLangCode);
                    const translationResult = result.text;

                    // إضافة مصدر الترجمة للأدمن فقط (للمتابعة)
                    const sourceNote = isAdmin ? ` _(${result.source})_` : '';
                    await reply(`${originalLabel} ${textToTranslate}\n\n${translatedLabel} ${translationResult}${sourceNote}`);

                    // إرسال الصوت تلقائياً بدون طلب "نعم"
                    let ttsCheck = null;
                    if (!isAdmin && !isVIPnow) {
                        ttsCheck = checkDailyTTS(sender);
                        if (!ttsCheck.allowed) {
                            await reply(`⚠️ وصلت للحد اليومي للصوت (${DAILY_TTS_LIMIT} مرات). الترجمة فوق بدون صوت.`);
                            await react('✅');
                            return;
                        }
                    }
                    await new Promise(r => setTimeout(r, 300));
                    const audio = await generateTTS(translationResult, targetLangCode);
                    await sendVoiceNote(jid, audio);
                    if (!isAdmin && !isVIPnow && ttsCheck) ttsCheck.commit?.();
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

            // ── 2. فلتر الرسائل التافهة (بدون AI) ──
            const trivialReply = getTrivialReply(body);
            if (trivialReply) {
                await reply(trivialReply);
                await react('😊');
                return;
            }

            // ── 6. Rate limiting ذكي ──
            await smartRateDelay(sender);

            // الحد اليومي للرسائل (الأدمن وVIP بلا حدود)
            const isVIP = isActiveVIP(sender);
            let _quotaCommit = null;
            if (!isAdmin && !isVIP) {
                const quota = checkDailyMessages(sender);
                if (!quota.allowed) {
                    await reply(
                        `*«عزيزي المستخدم»*\n\n` +
                        `*لقد انتهت الفترة التجريبية*\n\n` +
                        `يمكنك الآن الاشتراك في بوت MedTerm AI مساعدك الذكي المربوط في الذكاء الاصطناعي\n\n` +
                        `*ميزات البوت*\n\n` +
                        `*1-* بحث دقيق ( إجابات دقيقة وموثوقة)\n` +
                        `*2-* مربوط في (ديب سيك+جيميني+شات جي بي تي)\n` +
                        `*3-* اشتراك مدفوع وبدون حدود\n` +
                        `*4-* يمكن إرسال الرسائل قدر ما تشاء\n` +
                        `*5-* يمكنك إرسال صور قدر ما تشاء\n` +
                        `*6-* يمكنك البحث عن أي معلومة في الذكاء الاصطناعي\n` +
                        `*7-* يعمل حتى لو الإنترنت ضعيف (واي فاي أو بيانات الهاتف)\n\n` +
                        `*ملاحظة*\n` +
                        `أنت/ي تقوم بدفع 5 شيكل فقط في الشهر أرخص بـ 20 مرة من باقي أدوات الذكاء الاصطناعي\n\n` +
                        `كل الميزات التي ذكرت على سعر 5 شيكل فقط\n\n` +
                        `*طرق الدفع*\n` +
                        `(جوال باي أو بال باي)\n\n` +
                        `لدفع عن طريق بال باي\n` +
                        `الرقم : 0597111855\n` +
                        `باسم : *إياد معروف*\n\n` +
                        `لدفع عن طريق جوال باي\n` +
                        `الرقم : 0597111855\n` +
                        `باسم : *إياد معروف*\n\n` +
                        `بعد تحويل المبلغ الذي قدره 5 شيكل قم بمراسلة المهندس نادر\n\n` +
                        `*المهندس نادر* : +972 59-385-0520\n\n` +
                        `*أو عن طريق الرابط* : https://wa.me/972593850520`
                    );
                    const uName = userNames[sender] ? `${userNames[sender]} (${sender})` : sender;
                    notifyAdmin(`⚠️ المستخدم ${uName} انتهت فترته التجريبية (${DAILY_MSG_LIMIT} رسالة).`);
                    return;
                }
                _quotaCommit = quota.commit;
            }

            // ── 1. فحص كاش الأسئلة المتكررة ──
            const cachedAnswer = qaGet(body);
            if (cachedAnswer) {
                await react('⚡');
                // إضافة علامة خفية للأدمن فقط
                const cacheNote = isAdmin ? '\n\n_(من الكاش ⚡)_' : '';
                let cachedFinal = cachedAnswer + cacheNote;
                if (!isAdmin && !isVIP && _quotaCommit) {
                    _quotaCommit();
                    const rec = getDailyRecord(sender);
                    const msgLeft = Math.max(0, getUserDailyLimit(sender) - rec.messages);
                    cachedFinal += `\n\n─────────────\n_💬 رسائل: ${msgLeft}_`;
                } else if (_quotaCommit) {
                    _quotaCommit();
                }
                await reply(cachedFinal);
                await react('✅');
                return;
            }

            await react('👍');

            if (!userChats[sender]) userChats[sender] = [];

            // سياق أولي إذا كانت الجلسة فارغة
            if (userChats[sender].length === 0 && userName) {
                userChats[sender].push({ role: 'user',      content: `[اسم المستخدم: ${userName}]` });
                userChats[sender].push({ role: 'assistant', content: `أهلاً ${userName}، كيف أستطيع مساعدتك؟` });
            }

            stats.totalMessages++;
            saveData();

            // ── 5. ضغط السياق عند الامتلاء (بدل الحذف المباشر) ──
            const maxHist = isVIP ? 60 : MAX_HISTORY;
            if (userChats[sender].length >= maxHist) {
                userChats[sender] = await compressContext(userChats[sender]);
            }

            // ── 3. سياق متغير حسب نوع المحادثة ──
            const contextNeeded = isVIP ? maxHist : detectContextNeeded(body, userChats[sender]);

            // ✅ نضيف body للتاريخ أولاً، ثم نأخذ slice بعده
            userChats[sender].push({ role: 'user', content: body });
            const trimmedHistory = userChats[sender].slice(-contextNeeded);

            // اختيار system prompt ذكي: طبي للأسئلة الطبية، عام للباقي
            const smartPrompt = getSmartSystemPrompt(body, userLanguages[sender]);

            const res = await askAI([
                { role: 'system', content: smartPrompt },
                ...trimmedHistory
                // ✅ لا نضيف body مرة ثانية — هو موجود بالفعل في trimmedHistory
            ]);

            userChats[sender].push({ role: 'assistant', content: res });

            // ── 1. حفظ الجواب في الكاش ──
            qaSet(body, res);

            // إضافة رصيد المتبقي في نهاية الرد (للمستخدم العادي فقط)
            let finalRes = res;
            if (!isAdmin && !isVIP && _quotaCommit) {
                _quotaCommit(); // خصم الرسالة
                const rec = getDailyRecord(sender);
                const msgLimit   = getUserDailyLimit(sender);
                const msgLeft    = Math.max(0, msgLimit - rec.messages);
                const imgLeft    = Math.max(0, DAILY_IMG_LIMIT - (rec.images || 0));
                const ttsLeft    = Math.max(0, DAILY_TTS_LIMIT - (rec.tts || 0));
                if (msgLeft <= 5) {
                    finalRes += `\n\n─────────────\n` +
                        `⚠️ *تنبيه — رصيدك المتبقي اليوم:*\n` +
                        `💬 رسائل: *${msgLeft}* متبقية\n` +
                        `🖼️ صور: *${imgLeft}* متبقية\n` +
                        `🔊 صوت/ترجمة: *${ttsLeft}* متبقية\n` +
                        `_للاشتراك المميز (غير محدود): wa.me/972593850520_`;
                } else {
                    finalRes += `\n\n─────────────\n` +
                        `_💬 رسائل: ${msgLeft} | 🖼️ صور: ${imgLeft} | 🔊 صوت: ${ttsLeft}_`;
                }
            } else if (_quotaCommit) {
                _quotaCommit();
            }

            await reply(finalRes);
            await react('✅');

            // ── جلب صورة Wikipedia تلقائياً — يعمل في الخلفية بدون تأخير الرد ──
            if (needsVisualContext(body, res)) {
                (async () => {
                    try {
                        console.log('[wiki] 1️⃣ بدء البحث...');

                        const searchTerm = await getWikiSearchTerm(body, res);
                        console.log(`[wiki] 2️⃣ مصطلح البحث: "${searchTerm}"`);
                        if (!searchTerm) { console.warn('[wiki] ❌ لم يُستخرج مصطلح'); return; }

                        const imgResult = await fetchWikipediaImage(searchTerm);
                        console.log(`[wiki] 3️⃣ نتيجة Wikipedia:`, imgResult ? `"${imgResult.title}" — ${imgResult.url}` : 'null');
                        if (!imgResult) { console.warn('[wiki] ❌ لم تُجد صورة في Wikipedia'); return; }

                        const imgBuffer = await downloadImageBuffer(imgResult.url);
                        console.log(`[wiki] 4️⃣ تنزيل الصورة: ${imgBuffer?.length} bytes`);
                        if (!imgBuffer || imgBuffer.length < 5000) { console.warn('[wiki] ❌ الصورة فارغة أو صغيرة'); return; }

                        console.log('[wiki] 5️⃣ جاري رفع الصورة لـ Meta...');
                        await wa.sendImage(sender, imgBuffer, `📸 ${imgResult.title} — Wikipedia`);
                        console.log(`[wiki] ✅ أُرسلت صورة بنجاح: ${imgResult.title}`);

                    } catch(e) {
                        console.error('[wiki] ❌ فشل:', e.message);
                        // لو كان خطأ من uploadMedia اطبع التفاصيل
                        if (e.message.includes('uploadMedia')) {
                            console.error('[wiki] تفاصيل خطأ رفع الصورة:', e.message);
                        }
                    }
                })();
            }

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
            console.error('[processIncomingMessage]', error.message);
            try {
                await wa.sendReply(msg.key.remoteJid, 'حدث خطأ تقني، يرجى المحاولة مرة أخرى.', msg.key.id);
            } catch {}
        }
        } // نهاية for loop
}

// ============================================================
// WIKIPEDIA IMAGE — بحث دقيق بمساعدة الذكاء الاصطناعي
// ============================================================

function needsVisualContext(body, aiReply) {
    const combined = (body + ' ' + aiReply).toLowerCase();
    return /عضو|جهاز|حيوان|طائر|سمكة|نبات|شجرة|زهرة|عظمة|عضلة|وريد|شريان|خلية|بكتيريا|فيروس|دواء|علاج|آلة|معدة|كبد|قلب|رئة|كلية|دماغ|مخ|عصب|جلد|غدة|هرمون|بروتين|ذرة|كيمياء|فيزياء|هندسة|حشرة|زواحف|ثدييات|قارة|مدينة|دولة|برج|جسر|معلم|شخصية|عالم|مخترع|رياضي|نجم|كوكب|مجرة|جبل|نهر|بحيرة|محيط|صحراء|غابة|حاسوب|ديناصور|كائن|organism|animal|organ|muscle|bone|cell|bacteria|virus|drug|medicine|plant|flower|tree|bird|fish|insect|reptile|mammal|planet|star|galaxy|city|country|tower|bridge|mountain|river|lake|ocean|forest|computer|fossil|anatomy|chemistry|physics|engineering|scientist|inventor|monument|landmark/i.test(combined);
}

// الذكاء الاصطناعي يستخرج اسم Wikipedia الدقيق بالإنجليزي
async function getWikiSearchTerm(userQuery, aiReply) {
    try {
        const prompt =
            `المستخدم سأل: "${userQuery}"\n` +
            `الرد كان عن: "${aiReply.slice(0, 300)}"\n\n` +
            `اكتب اسم صفحة Wikipedia الإنجليزية الأدق لهذا الموضوع.\n` +
            `القواعد:\n` +
            `- اسم واحد فقط بالإنجليزي\n` +
            `- الاسم الرسمي الدقيق (مثال: Human heart, Albert Einstein, Eiffel Tower)\n` +
            `- إذا عالم أو شخصية: اسمه الكامل بالإنجليزي\n` +
            `- إذا عضو أو جهاز: اسمه الطبي الدقيق\n` +
            `- إذا مكان: اسمه الرسمي\n` +
            `- لا تضيف أي كلمة أخرى\n` +
            `الجواب (اسم واحد فقط):`;

        const term = await callMistral({
            model: 'mistral-small-latest',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 20,
            temperature: 0.1
        });

        const clean = term.trim().replace(/^["'\-*•]+|["'\-*•]+$/g, '').trim();
        console.log(`[wiki] مصطلح البحث: "${clean}"`);
        return clean || null;

    } catch(e) {
        console.warn('[wiki] فشل استخراج المصطلح:', e.message);
        return null;
    }
}

async function fetchWikipediaImage(searchTerm) {
    try {
        if (!searchTerm) return null;

        // دالة للتحقق إن الرابط صورة حقيقية (ليست SVG محوّلة)
        function isValidImgUrl(url) {
            if (!url) return false;
            const u = url.toLowerCase();
            // ارفض أي رابط فيه .svg في المسار حتى لو ينتهي بـ .png
            if (u.includes('.svg')) return false;
            if (u.includes('.gif')) return false;
            // قبل فقط JPEG و PNG حقيقية
            return /\.(jpg|jpeg|png)(\?.*)?$/i.test(u);
        }

        // الخطوة 1: البحث
        const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchTerm)}&srlimit=5&format=json&origin=*`;
        const searchRes = await fetchWithTimeout(searchUrl, {}, 8_000);
        if (!searchRes.ok) return null;
        const searchData = await searchRes.json();
        const results = searchData?.query?.search || [];
        if (!results.length) return null;

        let pageTitle = results[0].title;
        for (const r of results) {
            if (r.title.toLowerCase().includes(searchTerm.toLowerCase().split(' ')[0])) {
                pageTitle = r.title; break;
            }
        }
        console.log(`[wiki] صفحة Wikipedia: "${pageTitle}"`);

        // الخطوة 2: جلب thumbnail — مع فحص إنها ليست SVG
        const imgUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=pageimages&pithumbsize=800&format=json&origin=*`;
        const imgRes = await fetchWithTimeout(imgUrl, {}, 8_000);
        if (imgRes.ok) {
            const imgData = await imgRes.json();
            const pages   = imgData?.query?.pages || {};
            const page    = Object.values(pages)[0];
            let imgSrc    = page?.thumbnail?.source;
            if (imgSrc && isValidImgUrl(imgSrc)) {
                // نستخدم 800px بدل 1200px — أسرع في الرفع
                imgSrc = imgSrc.replace(/\/\d+px-/, '/800px-');
                console.log(`[wiki] ✅ thumbnail صالح: ${imgSrc}`);
                return { url: imgSrc, title: pageTitle };
            } else if (imgSrc) {
                console.warn(`[wiki] ⚠️ thumbnail مرفوض (SVG أو غير مدعوم): ${imgSrc}`);
            }
        }

        // الخطوة 3: قائمة الصور — نجرب واحدة واحدة حتى نجد صورة صالحة
        const listUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=images&imlimit=20&format=json&origin=*`;
        const listRes = await fetchWithTimeout(listUrl, {}, 8_000);
        if (!listRes.ok) return null;
        const listData = await listRes.json();
        const listPage = Object.values(listData?.query?.pages||{})[0];

        const candidates = (listPage?.images || []).filter(i => {
            const name = i.title.toLowerCase();
            // ✅ رفض SVG وكل المحوّلات منه
            return /\.(jpg|jpeg|png)$/i.test(name) &&
                   !name.includes('.svg') &&
                   !name.includes('icon') && !name.includes('logo') &&
                   !name.includes('flag') && !name.includes('map') &&
                   !name.includes('symbol') && !name.includes('wikimedia') &&
                   !name.includes('signature') && !name.includes('commons-logo');
        });

        console.log(`[wiki] ${candidates.length} صورة مرشحة من ${listPage?.images?.length||0}`);

        // نجرب أول 5 صور ونتوقف عند أول صالحة
        for (const candidate of candidates.slice(0, 5)) {
            const fileUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(candidate.title)}&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=800&format=json&origin=*`;
            const fileRes = await fetchWithTimeout(fileUrl, {}, 6_000);
            if (!fileRes.ok) continue;
            const fileData = await fileRes.json();
            const filePages = fileData?.query?.pages || {};
            const info = Object.values(filePages)[0]?.imageinfo?.[0];
            const url  = info?.thumburl || info?.url;
            const mime = info?.mime || '';

            // تحقق من النوع والرابط
            if (!url) continue;
            if (mime.includes('svg') || mime.includes('gif')) {
                console.warn(`[wiki] تجاوز ${candidate.title} (${mime})`);
                continue;
            }
            if (!isValidImgUrl(url)) {
                console.warn(`[wiki] تجاوز رابط غير صالح: ${url}`);
                continue;
            }

            console.log(`[wiki] ✅ صورة صالحة: ${url}`);
            return { url, title: pageTitle };
        }

        console.warn(`[wiki] ❌ لم تُجد صورة JPEG/PNG صالحة لـ "${pageTitle}"`);
        return null;

    } catch(e) {
        console.error('[fetchWikipediaImage]', e.message);
        return null;
    }
}

async function downloadImageBuffer(url) {
    const res = await fetchWithTimeout(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; MedTermBot/1.0)',
            'Accept': 'image/jpeg,image/png,image/gif,image/webp,*/*'
        }
    }, 15_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    // Meta لا تقبل SVG
    if (contentType.includes('svg') || contentType.includes('pdf')) {
        throw new Error(`نوع غير مدعوم: ${contentType}`);
    }

    const arr = await res.arrayBuffer();
    const buffer = Buffer.from(arr);

    // فحص SVG من المحتوى
    const preview = buffer.slice(0, 60).toString('utf8');
    if (preview.includes('<svg') || preview.includes('<?xml')) {
        throw new Error('صورة SVG غير مدعومة في واتساب');
    }

    console.log(`[downloadImg] ${buffer.length} bytes | ${contentType}`);
    return buffer;
}




// فحص انتهاء VIP كل ساعة
setInterval(checkVIPExpiry, 60 * 60_000);






// ============================================================
// فحص التبعيات عند البدء
// ============================================================
(function checkDependencies() {
    const { execSync, spawnSync } = require('child_process');
    const path = require('path');

    // دالة مرنة: تبحث عن الأداة في كل المسارات المحتملة
    function findTool(name) {
        // 1) which / where (Linux/Mac/Termux) — timeout قصير لمنع التعليق
        try {
            const r = spawnSync('which', [name], { encoding: 'utf8', timeout: 3000 });
            if (!r.error && r.status === 0 && r.stdout.trim()) return r.stdout.trim();
        } catch (_) {}

        // 2) مسارات Termux الشائعة (بدون spawnSync — فحص وجود الملف فقط)
        const termuxPaths = [
            `/data/data/com.termux/files/usr/bin/${name}`,
            `/data/data/com.termux/files/usr/local/bin/${name}`,
            `/usr/bin/${name}`,
            `/usr/local/bin/${name}`,
            `/bin/${name}`,
        ];
        for (const p of termuxPaths) {
            try {
                if (require('fs').existsSync(p)) return p;
            } catch (_) {}
        }

        // 3) محاولة تشغيل مباشرة — timeout صارم لمنع التعليق
        try {
            const r = spawnSync(name, ['--version'], { encoding: 'utf8', timeout: 2000 });
            if (!r.error && (r.status === 0 || (r.stderr && r.stderr.length > 0))) return name;
        } catch (_) {}

        // 4) للـ mutool تحديداً — تجربة اسم بديل
        if (name === 'mutool') {
            try {
                const r = spawnSync('mupdf', ['--version'], { encoding: 'utf8', timeout: 2000 });
                if (!r.error && (r.status === 0 || (r.stderr && r.stderr.length > 0))) return 'mupdf';
            } catch (_) {}
        }

        return null;
    }

    // فحص mutool
    const mutoolPath = findTool('mutool');
    if (!mutoolPath) {
        console.error('❌ mutool غير مثبت أو غير موجود في PATH.');
        console.error('   ثبّته بـ:  pkg install mupdf-tools');
        console.error('   أو تأكد من: echo $PATH');
        process.exit(1);
    }
    console.log(`✅ mutool: ${mutoolPath}`);

    // فحص ffmpeg
    const ffmpegPath = findTool('ffmpeg');
    if (!ffmpegPath) {
        console.error('❌ ffmpeg غير مثبت أو غير موجود في PATH.');
        console.error('   ثبّته بـ:  pkg install ffmpeg');
        process.exit(1);
    }
    console.log(`✅ ffmpeg: ${ffmpegPath}`);

    console.log('✅ جميع التبعيات موجودة وجاهزة.');
})();

cleanPdfCache(); // تنظيف كاش PDF القديمة عند البدء
console.log(`🚀 جاري تشغيل ${BOT_NAME}...`);
startWebServer();
startBot();
