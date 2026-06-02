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
const { fromBuffer } = require('pdf2pic');

// ============================================================
// CONFIG
// ============================================================
const MISTRAL_API_KEY = 'fZ0TSrAOJK3cBjkmj461Msqhk90d0HiL';
const ADMIN_NUMBER    = '972593850520';   // بدون + أو @
const BOT_NAME        = 'MedTerm';
const DATA_FILE       = './bot_data.json';
const WEB_PORT        = 8080;

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
        reports:        [],
        userLimits:     {},   // حدود مخصصة لكل مستخدم { sender: limit }
        blacklist:      [],   // أرقام محظورة
        userLanguages:  {},   // لغة كل مستخدم { sender: 'ar'|'en'|... }
        userStats:      {},   // إحصائيات لكل مستخدم { sender: { totalSent, totalImages, totalDocs, firstSeen, lastSeen } }
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
                { userNames, welcomedUsers, vipNumbers, reports, userLimits, blacklist, userLanguages, userStats, stats },
                null, 2
            ));
            fs.renameSync(tmp, DATA_FILE);
        } catch (e) {
            console.error('[saveData] خطأ:', e.message);
        }
    }, 500);
}

let { userNames, welcomedUsers, vipNumbers, reports, userLimits, blacklist, userLanguages, userStats, stats } = loadData();

// ضمان وجود الحقول
if (!Array.isArray(reports))   reports = [];
if (!userLimits)               userLimits = {};
if (!Array.isArray(blacklist)) blacklist = [];
if (!userLanguages)            userLanguages = {};
if (!stats)                    stats   = { totalMessages: 0, totalImages: 0, totalMedical: 0, totalDocs: 0 };
if (!stats.totalMessages)      stats.totalMessages = 0;
if (!stats.totalImages)        stats.totalImages   = 0;
if (!stats.totalMedical)       stats.totalMedical  = 0;
if (!stats.totalDocs)          stats.totalDocs     = 0;
if (!userStats)                userStats = {};

// إضافة الأدمن للمستخدمين المرحّب بهم تلقائياً حتى لا يستقبل رسالة ترحيب
welcomedUsers[ADMIN_NUMBER] = true;
saveData();

let userChats       = {};   // سياق المحادثة (RAM فقط)
let userChatLastSeen = {}; // آخر نشاط لكل مستخدم
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
    // ISO string صريح لتجنب أي ambiguity في الـ parsing
    const isoStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
    return new Date(isoStr);
}

// ============================================================
// RATE LIMITING & DAILY MESSAGE QUOTA
// ============================================================
const DAILY_MSG_LIMIT = 20; // رسائل نصية/24 ساعة لكل مستخدم عادي
const BLACKLIST_MSG   = '⛔ عذراً، تم حظرك من استخدام هذا البوت.\nللاستفسار تواصل مع الإدارة.'; // رسالة للمحظورين
const _userDailyLimit = {}; // { sender: { messages, images, docs, resetAt } }

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
            resetAt:  getNextMidnightMs()
        };
    }
    return _userDailyLimit[sender];
}

// فحص الحد اليومي للرسائل النصية — يُعيد { allowed, remaining }
function checkDailyMessages(sender) {
    const limit = getUserDailyLimit(sender);
    const rec = getDailyRecord(sender);
    if (rec.messages >= limit) return { allowed: false, remaining: 0, limit };
    rec.messages++;
    return { allowed: true, remaining: limit - rec.messages, limit };
}

// فحص الحد اليومي للصور والملفات
function checkDailyLimit(sender, type) {
    const d = getDailyRecord(sender);
    if (type === 'image') { if (d.images >= 20) return false; d.images++; return true; }
    if (type === 'pdf')   { if (d.docs   >= 10) return false; d.docs++;   return true; }
    return true;
}

// Anti-spam فقط: منع إرسال الرسائل بشكل متسارع جداً (3 رسائل/5 ثواني)
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

// تحديث إحصائيات المستخدم الفردية
function updateUserStats(sender, type = 'message') {
    if (!userStats[sender]) {
        userStats[sender] = { totalSent: 0, totalImages: 0, totalDocs: 0, firstSeen: Date.now(), lastSeen: Date.now() };
    }
    userStats[sender].lastSeen = Date.now();
    if (type === 'message') userStats[sender].totalSent = (userStats[sender].totalSent || 0) + 1;
    else if (type === 'image') userStats[sender].totalImages = (userStats[sender].totalImages || 0) + 1;
    else if (type === 'doc')   userStats[sender].totalDocs   = (userStats[sender].totalDocs   || 0) + 1;
}


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
        const isMedical    = isMedicalImage(userQuestion);
        const systemToUse  = isMedical ? MEDICAL_IMAGE_PROMPT : getSystemPrompt();
        const mime         = mimeType || 'image/jpeg';

        // إذا ما في سؤال: استخرج النص أولاً ثم اشرح
        const hasQuestion  = userQuestion && userQuestion.trim().length > 0;
        const questionText = hasQuestion
            ? userQuestion
            : isMedical
                ? 'حلل هذه الصورة الطبية بالتفصيل الكامل، واذكر كل ما تراه'
                : `افحص هذه الصورة بدقة عالية:
1. إذا فيها نص أو كلام أو أرقام: اقرأه كاملاً كما هو بالضبط دون أي تغيير
2. إذا فيها جدول أو بيانات: اكتبها منظمة
3. اشرح محتوى الصورة بالتفصيل
كن دقيقاً جداً في قراءة النصوص ولا تخمّن`;

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
            max_tokens: isMedical ? 2500 : 2000,
            temperature: isMedical ? 0.2 : 0.3
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
            `_يمكنك أيضاً إرسال صور أو ملفات PDF للتحليل_`
        );
        return true;
    }

    // !مسح — مسح سياق المحادثة
    if (command === '!مسح' || command === '!reset') {
        userChats[sender] = [];
        await react('✅');
        await reply('🗑️ تم مسح سياق المحادثة. ابدأ محادثة جديدة!');
        return true;
    }

    // !رصيد — عرض الرصيد المتبقي
    if (command === '!رصيد' || command === '!balance') {
        if (isAdmin || isVIP) {
            const uSt = userStats[sender] || {};
            await reply(
                `♾️ *رصيدك غير محدود (VIP/أدمن)*\n\n` +
                `📊 *إحصائياتك الكلية:*\n` +
                `• إجمالي الرسائل: ${uSt.totalSent || 0}\n` +
                `• الصور المحللة: ${uSt.totalImages || 0}\n` +
                `• الملفات المعالجة: ${uSt.totalDocs || 0}`
            );
        } else {
            const limit = getUserDailyLimit(sender);
            const rec   = getDailyRecord(sender);
            const used  = rec.messages;
            const remaining = Math.max(0, limit - used);
            const resetDate = new Date(rec.resetAt);
            const resetStr  = resetDate.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
            const uSt = userStats[sender] || {};
            await reply(
                `📊 *رصيدك اليوم:*\n\n` +
                `✅ استخدمت: ${used} رسالة\n` +
                `🔄 متبقي: *${remaining}* رسالة\n` +
                `📅 يتجدد عند: ${resetStr}\n` +
                `📏 الحد اليومي: ${limit} رسالة\n\n` +
                `📈 *إحصائياتك الكلية:*\n` +
                `• إجمالي الرسائل المرسلة: ${uSt.totalSent || 0}\n` +
                `• الصور المحللة: ${uSt.totalImages || 0}\n` +
                `• الملفات المعالجة: ${uSt.totalDocs || 0}`
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
        const convMsgs = history.filter(m => !m.content.startsWith('['));
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

    const server = http.createServer(async (req, res) => {
        // إغلاق الاتصال بعد الاستجابة
        res.setHeader('Connection', 'close');
        const ip  = req.socket.remoteAddress || 'unknown';
        const url = req.url.split('?')[0];

        if (!checkWebRate(ip)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Too many requests' }));
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
                            userLimits[num] = limit;
                            // إعادة ضبط عداد اليوم ليطبّق الحد الجديد فوراً
                            if (_userDailyLimit[num]) {
                                _userDailyLimit[num].messages = 0;
                            }
                            saveData();
                            // إشعار المستخدم تلقائياً
                            if (sock && isConnected) {
                                try {
                                    const jid = `${num}@s.whatsapp.net`;
                                    const name = userNames[num] ? `${userNames[num]}` : '';
                                    await sock.sendMessage(jid, {
                                        text: `🎉 ${name ? `أهلاً ${name}، ` : ''}تم رفع حد رسائلك اليومي إلى *${limit}* رسالة!\n\nيمكنك الآن الاستمرار في المحادثة. 🚀`
                                    });
                                } catch (e) {
                                    console.error('[setUserLimit notify]', e.message);
                                }
                            }
                            result.msg = `تم تعيين حد ${limit} رسالة للمستخدم ${num}`;
                        }
                    }
                    else if (action === 'resetUserLimit') {
                        // إعادة المستخدم للحد الافتراضي
                        const num = (data.num || '').replace(/\D/g, '');
                        if (num) {
                            delete userLimits[num];
                            if (_userDailyLimit[num]) _userDailyLimit[num].messages = 0;
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

        // ===== DATA API (dashboard-only — requires Origin check) =====
        if (url === '/data') {
            // Block cross-origin / external access: only allow requests from the
            // same server (no Origin header = same-origin fetch/XHR).
            const origin = req.headers['origin'];
            if (origin) {
                // Requests from a browser page on a different origin include Origin.
                // Reject them to prevent drive-by data extraction.
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, msg: 'Forbidden' }));
                return;
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
                userLimits,
                userNames,
                blacklist: blacklist || [],
                welcomedUsers: Object.keys(welcomedUsers),
                userStats: userStats || {},
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
    <div class="tab" onclick="showTab('userstats')">📈 إحصائيات المستخدمين</div>
    <div class="tab" onclick="showTab('limits')">🔢 حدود الرسائل</div>
    <div class="tab" onclick="showTab('vip')">⭐ VIP</div>
    <div class="tab" onclick="showTab('blacklist')">⛔ المحظورون</div>
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
      <div class="sc"><div class="n" id="s-docs">—</div><div class="l">📄 ملفات</div></div>
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

  <!-- إحصائيات المستخدمين -->
  <div class="panel" id="panel-userstats">
    <div class="card">
      <div class="ch">
        <h3>📈 إحصائيات المستخدمين التفصيلية</h3>
        <input class="inp" style="width:200px;padding:6px 10px" id="ustats-search" placeholder="بحث بالرقم أو الاسم..." oninput="filterUserStats()">
      </div>
      <table>
        <thead><tr><th>الرقم</th><th>الاسم</th><th>💬 رسائل كلية</th><th>🖼️ صور</th><th>📄 ملفات</th><th>📅 آخر نشاط</th><th>الحد اليومي</th></tr></thead>
        <tbody id="userstats-table"><tr><td colspan="7" class="empty">جاري التحميل...</td></tr></tbody>
      </table>
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

  <!-- حدود الرسائل -->
  <div class="panel" id="panel-limits">
    <div class="card">
      <div class="ch">
        <h3>🔢 حدود الرسائل اليومية</h3>
        <span id="default-limit-label" style="font-size:12px;color:#64748b"></span>
      </div>
      <div style="padding:14px 18px;background:#0f172a;border-bottom:1px solid #334155;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:13px;color:#94a3b8">تعيين حد لمستخدم محدد:</span>
        <input class="inp" id="limit-num" placeholder="رقم الهاتف" dir="ltr" style="width:180px">
        <input class="inp" id="limit-val" placeholder="عدد الرسائل" type="number" min="0" style="width:130px">
        <button class="btn btn-b" onclick="setUserLimit()">✅ تعيين وإشعار</button>
        <button class="btn btn-r" onclick="resetUserLimit()">↩️ إعادة للافتراضي</button>
      </div>
      <table>
        <thead><tr><th>الرقم</th><th>الاسم</th><th>الحد المخصص</th><th>إجراء</th></tr></thead>
        <tbody id="limits-table"><tr><td colspan="4" class="empty">لا يوجد حدود مخصصة</td></tr></tbody>
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

  <!-- المحظورون -->
  <div class="panel" id="panel-blacklist">
    <div class="card">
      <div class="ch"><h3>⛔ قائمة المحظورين</h3></div>
      <div style="padding:14px 18px;background:#0f172a;border-bottom:1px solid #334155;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:13px;color:#94a3b8">حظر مستخدم:</span>
        <input class="inp" id="bl-num" placeholder="رقم الهاتف مع كود الدولة" dir="ltr" style="width:200px">
        <button class="btn btn-r" onclick="addBlacklist()">⛔ حظر وإشعار</button>
      </div>
      <table>
        <thead><tr><th>الرقم</th><th>الاسم</th><th>إجراء</th></tr></thead>
        <tbody id="blacklist-table"><tr><td colspan="3" class="empty">لا يوجد مستخدمون محظورون</td></tr></tbody>
      </table>
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
// XSS helper — escapes all dangerous HTML characters
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

let _data = null;

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => {
    const names = ['overview','qr','broadcast','users','userstats','limits','vip','blacklist','reports'];
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
  setText('s-docs', s.docs);
  setText('s-med', s.medical);
  setText('s-rep', s.reports);

  // broadcast count
  const bc = document.getElementById('broadcast-count');
  if (bc) bc.textContent = 'سيصل لـ ' + (s.users - 1) + ' مستخدم';

  // default limit label
  const dll = document.getElementById('default-limit-label');
  if (dll) dll.textContent = 'الحد الافتراضي: ' + (d.defaultLimit || 20) + ' رسالة/يوم';

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

  // Limits
  renderLimits(d);

  // VIP
  renderVip(d);

  // Reports
  renderReports(d);

  // Users stats
  renderUserStats(d);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}

let _allUserStats = [];
function renderUserStats(d) {
  const uStats = d.userStats || {};
  const limits = d.userLimits || {};
  _allUserStats = d.welcomedUsers.map(num => ({
    num,
    name: d.userNames[num] || '—',
    totalSent:   (uStats[num]?.totalSent   || 0),
    totalImages: (uStats[num]?.totalImages || 0),
    totalDocs:   (uStats[num]?.totalDocs   || 0),
    lastSeen:    uStats[num]?.lastSeen || 0,
    limit: limits[num] != null ? limits[num] : (d.defaultLimit || 20),
    isVip: d.vipNumbers.includes(num)
  })).sort((a,b) => b.totalSent - a.totalSent);
  filterUserStats();
}

function filterUserStats() {
  const q = (document.getElementById('ustats-search')?.value || '').toLowerCase();
  const filtered = q ? _allUserStats.filter(u => u.num.includes(q) || u.name.toLowerCase().includes(q)) : _allUserStats;
  const tb = document.getElementById('userstats-table');
  if (!filtered.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">لا توجد بيانات</td></tr>'; return; }
  tb.innerHTML = filtered.slice(0, 200).map(u => {
    const safeNum  = esc(u.num);
    const safeName = esc(u.name);
    const lastDate = u.lastSeen ? new Date(u.lastSeen).toLocaleString('ar-SA') : '—';
    const limitBadge = u.isVip
      ? \`<span class="badge badge-b">♾️ VIP</span>\`
      : \`<span class="badge badge-g">\${u.limit} رسالة/يوم</span>\`;
    return \`<tr>
      <td dir="ltr">\${safeNum}</td>
      <td>\${safeName}</td>
      <td style="text-align:center;font-weight:700;color:#38bdf8">\${u.totalSent}</td>
      <td style="text-align:center">\${u.totalImages}</td>
      <td style="text-align:center">\${u.totalDocs}</td>
      <td style="font-size:11px;color:#94a3b8">\${lastDate}</td>
      <td>\${limitBadge}</td>
    \`;
  }).join('');
}


function renderUsers(d) {
  _allUsers = d.welcomedUsers.map(num => ({
    num,
    name: d.userNames[num] || '—',
    isVip: d.vipNumbers.includes(num),
    isBlocked: (d.blacklist || []).includes(num)
  }));
  filterUsers();
}

function filterUsers() {
  const q = (document.getElementById('user-search')?.value || '').toLowerCase();
  const filtered = q ? _allUsers.filter(u => u.num.includes(q) || u.name.toLowerCase().includes(q)) : _allUsers;
  const tb = document.getElementById('users-table');
  if (!filtered.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">لا يوجد مستخدمون</td></tr>'; return; }
  tb.innerHTML = filtered.slice(0,100).map(u => {
    const safeNum  = esc(u.num);
    const safeName = esc(u.name);
    const addVipBtn    = \`<button class="btn btn-b" onclick="addVipNum(\${JSON.stringify(u.num)})">+ VIP</button>\`;
    const removeVipBtn = \`<button class="btn btn-y" onclick="removeVipNum(\${JSON.stringify(u.num)})">إزالة VIP</button>\`;
    const deleteBtn    = \`<button class="btn btn-r" onclick="deleteUser(\${JSON.stringify(u.num)})">حذف</button>\`;
    const limitBtn     = \`<button class="btn btn-y" onclick="quickSetLimit(\${JSON.stringify(u.num)})">🔢 حد</button>\`;
    const blockBtn     = u.isBlocked
      ? \`<button class="btn btn-g" onclick="removeBlacklistNum(\${JSON.stringify(u.num)})">✅ رفع حظر</button>\`
      : \`<button class="btn" style="background:#7c3aed;color:#fff" onclick="blockUser(\${JSON.stringify(u.num)})">⛔ حظر</button>\`;
    const badge = u.isBlocked
      ? '<span class="badge badge-r">⛔ محظور</span>'
      : u.isVip ? '<span class="badge badge-b">⭐ VIP</span>' : '<span class="badge badge-g">عادي</span>';
    return \`<tr>
      <td dir="ltr">\${safeNum}</td>
      <td>\${safeName}</td>
      <td>\${badge}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        \${!u.isVip && !u.isBlocked ? addVipBtn : u.isVip ? removeVipBtn : ''}
        \${limitBtn}
        \${blockBtn}
        \${deleteBtn}
      </td>
    </tr>\`;
  }).join('');
}

async function blockUser(num) {
  if (!confirm(\`حظر المستخدم \${num}؟ سيصله إشعار تلقائي.\`)) return;
  const r = await api('addBlacklist', { num });
  if (r.ok) { toast('⛔ تم الحظر'); loadData(); }
  else toast(r.msg || 'فشل', '#dc2626');
}



function renderVip(d) {
  const tb = document.getElementById('vip-table');
  if (!d.vipNumbers.length) { tb.innerHTML = '<tr><td colspan="3" class="empty">لا يوجد أرقام VIP</td></tr>'; return; }
  tb.innerHTML = d.vipNumbers.map(num => {
    const safeNum  = esc(num);
    const safeName = esc(d.userNames[num] || '—');
    return \`<tr>
      <td dir="ltr">\${safeNum}</td>
      <td>\${safeName}</td>
      <td><button class="btn btn-r" onclick="removeVipNum(\${JSON.stringify(num)})">حذف</button></td>
    </tr>\`;
  }).join('');
}

function renderReports(d) {
  const tb = document.getElementById('reports-table');
  if (!d.reports.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">لا يوجد بلاغات</td></tr>'; return; }
  tb.innerHTML = d.reports.map((r,i) => {
    return \`<tr>
      <td>\${i+1}</td>
      <td>\${esc(r.name || '—')}</td>
      <td dir="ltr" style="font-size:12px">\${esc(r.sender)}</td>
      <td>\${esc(r.text)}</td>
      <td style="font-size:11px;color:#64748b">\${esc(r.time)}</td>
    </tr>\`;
  }).join('');
}

function renderLimits(d) {
  const tb = document.getElementById('limits-table');
  const limits = d.userLimits || {};
  const keys = Object.keys(limits);
  if (!keys.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">لا يوجد حدود مخصصة — جميع المستخدمين على الحد الافتراضي (' + (d.defaultLimit||20) + ')</td></tr>'; return; }
  tb.innerHTML = keys.map(num => {
    const safeNum  = esc(num);
    const safeName = esc(d.userNames[num] || '—');
    const lim      = limits[num];
    return \`<tr>
      <td dir="ltr">\${safeNum}</td>
      <td>\${safeName}</td>
      <td><span class="badge badge-b">\${lim} رسالة/يوم</span></td>
      <td><button class="btn btn-r" onclick="resetUserLimitNum(\${JSON.stringify(num)})">↩️ إعادة</button></td>
    </tr>\`;
  }).join('');
}

async function setUserLimit() {
  const num   = document.getElementById('limit-num').value.replace(/\D/g,'');
  const limit = parseInt(document.getElementById('limit-val').value, 10);
  if (!num) { toast('أدخل رقم الهاتف', '#f59e0b'); return; }
  if (isNaN(limit) || limit < 0) { toast('أدخل عدداً صحيحاً', '#f59e0b'); return; }
  const r = await api('setUserLimit', { num, limit });
  if (r.ok) {
    toast('✅ تم تعيين الحد وإشعار المستخدم');
    document.getElementById('limit-num').value = '';
    document.getElementById('limit-val').value = '';
    loadData();
  } else {
    toast(r.msg || 'فشل', '#dc2626');
  }
}

async function resetUserLimit() {
  const num = document.getElementById('limit-num').value.replace(/\D/g,'');
  if (!num) { toast('أدخل رقم الهاتف', '#f59e0b'); return; }
  const r = await api('resetUserLimit', { num });
  if (r.ok) { toast('تم الإعادة للافتراضي'); loadData(); }
}

async function resetUserLimitNum(num) {
  const r = await api('resetUserLimit', { num });
  if (r.ok) { toast('تم الإعادة للافتراضي'); loadData(); }
}

async function addVip() {
  const num = document.getElementById('new-vip').value.replace(/\D/g,'');
  if (!num) { toast('أدخل رقماً صحيحاً', '#f59e0b'); return; }
  const r = await api('addVip', { num });
  if (r.ok) { toast('✅ تم إضافة VIP'); document.getElementById('new-vip').value = ''; loadData(); }
}

async function quickSetLimit(num) {
  const val = prompt(\`عدد الرسائل اليومية للمستخدم \${num}:\`);
  if (val === null) return;
  const limit = parseInt(val, 10);
  if (isNaN(limit) || limit < 0) { toast('رقم غير صحيح', '#f59e0b'); return; }
  const r = await api('setUserLimit', { num, limit });
  if (r.ok) { toast('✅ تم وتم إشعار المستخدم'); loadData(); }
  else toast(r.msg || 'فشل', '#dc2626');
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

function renderBlacklist(d) {
  const tb = document.getElementById('blacklist-table');
  const bl = d.blacklist || [];
  if (!bl.length) { tb.innerHTML = '<tr><td colspan="3" class="empty">لا يوجد مستخدمون محظورون</td></tr>'; return; }
  tb.innerHTML = bl.map(num => {
    const safeNum  = esc(num);
    const safeName = esc(d.userNames[num] || '—');
    return \`<tr>
      <td dir="ltr">\${safeNum}</td>
      <td>\${safeName}</td>
      <td>
        <button class="btn btn-g" onclick="removeBlacklistNum(\${JSON.stringify(num)})">✅ رفع الحظر</button>
      </td>
    </tr>\`;
  }).join('');
}

async function addBlacklist() {
  const num = document.getElementById('bl-num').value.replace(/\D/g,'');
  if (!num) { toast('أدخل رقماً صحيحاً', '#f59e0b'); return; }
  if (!confirm(\`حظر المستخدم \${num}؟ سيصله إشعار تلقائي.\`)) return;
  const r = await api('addBlacklist', { num });
  if (r.ok) { toast('⛔ تم الحظر وإشعار المستخدم'); document.getElementById('bl-num').value = ''; loadData(); }
  else toast(r.msg || 'فشل', '#dc2626');
}

async function removeBlacklistNum(num) {
  if (!confirm(\`رفع الحظر عن \${num}؟\`)) return;
  const r = await api('removeBlacklist', { num });
  if (r.ok) { toast('✅ تم رفع الحظر'); loadData(); }
  else toast(r.msg || 'فشل', '#dc2626');
}

// إضافة زر حظر في جدول المستخدمين — مُنجز أعلاه في renderUsers

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
// تحديث الداشبورد كل 30 ثانية فقط إذا كانت الصفحة نشطة
setInterval(loadData, 30000);
</script>
</body>
</html>`);
    });

    function tryListen(port) {
        const s = require('net').createServer();
        s.once('error', () => {
            console.log(`⚠️ البورت ${port} مشغول، جاري المحاولة على ${port + 1}...`);
            tryListen(port + 1);
        });
        s.once('listening', () => {
            s.close(() => {
                server.listen(port, '0.0.0.0', () => {
                    console.log(`\n🌐 لوحة التحكم: http://localhost:${port}`);
                    console.log(`🌐 من جهاز ثاني: http://10.158.171.59:${port}\n`);
                });
            });
        });
        s.listen(port, '0.0.0.0');
    }

    server.on('error', (e) => {
        console.error('[server]', e.message);
    });

    tryListen(WEB_PORT);
}

// ============================================================
// WELCOME MESSAGE
// ============================================================
function buildWelcome(name) {
    const first    = name ? name.split(' ')[0] : null;
    const greeting = first ? `أهلاً ${first}` : 'أهلاً';
    return `${greeting} 👋\n\nأنا *${BOT_NAME}*، مساعد ذكاء اصطناعي على واتساب.\n\nأستطيع مساعدتك في:\n• الإجابة على أي سؤال\n• تحليل الصور والصور الطبية 🖼️\n• قراءة وتلخيص ملفات PDF 📄\n• فهم الرسائل الصوتية 🎙️\n• معلومات طبية وعلمية دقيقة\n\n📋 *أوامر متاحة:*\n• !مساعدة — قائمة الأوامر\n• !مسح — مسح المحادثة\n• !رصيد — عرض رصيدك\n• !ملخص — تلخيص المحادثة\n\nفقط كلمني بشكل طبيعي وسأرد عليك 🤝`;
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
        }

        if (connection === 'close') {
            isConnected = false;
            const errCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = errCode !== DisconnectReason.loggedOut;
            console.log('❌ انقطع الاتصال، الكود:', errCode);
            if (shouldReconnect) {
                if (!isReconnecting) {
                    isReconnecting = true;
                    let delay = 5000;
                    const tryReconnect = () => {
                        console.log(`🔄 محاولة إعادة الاتصال خلال ${delay/1000}ث...`);
                        const currentDelay = delay;
                        delay = Math.min(delay * 2, 60_000); // exponential backoff حتى دقيقة
                        setTimeout(() => {
                            isReconnecting = false;
                            startBot();
                        }, currentDelay);
                    };
                    tryReconnect();
                }
            } else {
                console.log('🚪 تم تسجيل الخروج. احذف مجلد session وأعد التشغيل.');
                isReconnecting = false;
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

            // تحديد نوع المحادثة
            const isGroup = jid.endsWith('@g.us');

            // استخراج رقم المرسل بشكل موثوق
            const sender = cleanNumber(
                msg.key?.participant || (isGroup ? msg.key?.participant : jid)
            );
            if (!sender) return;

            const isAdmin = sender === ADMIN_NUMBER;
            userChatLastSeen[sender] = Date.now(); // تحديث آخر نشاط

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
            // أوامر الأدمن — تُدار من لوحة التحكم فقط
            // الأدمن يستخدم البوت كمستخدم عادي
            // ============================================================

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
            // رسالة الترحيب (للمستخدمين الجدد فقط - في المحادثات الخاصة)
            // ============================================================
            if (!welcomedUsers[sender]) {
                welcomedUsers[sender] = true;
                userChats[sender] = [];
                // تهيئة إحصائيات المستخدم الجديد
                if (!userStats[sender]) {
                    userStats[sender] = { totalSent: 0, totalImages: 0, totalDocs: 0, firstSeen: Date.now(), lastSeen: Date.now() };
                }
                if (userName) {
                    userChats[sender].push({ role: 'user',      content: `[اسم المستخدم: ${userName}]` });
                    userChats[sender].push({ role: 'assistant', content: `أهلاً ${userName}، كيف أستطيع مساعدتك؟` });
                }
                saveData();
                // إشعار الأدمن بالمستخدم الجديد
                if (!isGroup && !isAdmin) {
                    const adminMsg =
                        `🆕 *مستخدم جديد انضم للبوت*\n\n` +
                        `👤 الاسم: ${userName || 'غير معروف'}\n` +
                        `📱 الرقم: ${sender}\n` +
                        `🕐 الوقت: ${nowJerusalem().toLocaleString('ar-SA')}\n\n` +
                        `_تم حضره تلقائياً — تواصل معه إذا لزم_`;
                    notifyAdmin(adminMsg);
                }
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
                if (!checkDailyLimit(sender, 'image')) {
                    await reply('⚠️ وصلت للحد اليومي للصور (20 صورة/يوم).');
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
                    const isMed = isMedicalImage(body);
                    stats.totalImages++;
                    if (isMed) stats.totalMedical++;
                    updateUserStats(sender, 'image');
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

                    // استخراج النص — محاولتان: pdf-parse ثم fallback بدون options
                    let docText = '';
                    try {
                        // المحاولة الأولى: pdf-parse مع options مرنة
                        const parsed = await pdfParse(buffer, {
                            // تجاهل بعض metadata الخاصة التي تسبب خطأ "encrypted"
                            max: 0
                        });
                        docText = (parsed.text || '').trim();
                        console.log(`[PDF] استُخرج ${docText.length} حرف من "${fileName}"`);
                    } catch (pdfErr) {
                        console.warn('[pdf-parse attempt1]', pdfErr.message);
                        // المحاولة الثانية: pdf-parse بدون options إضافية
                        try {
                            const parsed2 = await pdfParse(buffer);
                            docText = (parsed2.text || '').trim();
                            console.log(`[PDF fallback] استُخرج ${docText.length} حرف من "${fileName}"`);
                        } catch (pdfErr2) {
                            console.error('[pdf-parse attempt2]', pdfErr2.message);
                            // لو فشل كل شيء، سيتم التعامل معه كـ PDF مصوّر
                        }
                    }

                    // لو النص فارغ: الـ PDF مصوّر - نحوّل صفحاته لصور JPG
                    if (!docText || docText.length < 10) {
                        console.log(`[PDF] "${fileName}" مصوّر، جاري تحويله لصور...`);
                        try {
                            // تحويل صفحات PDF لصور JPG باستخدام pdf2pic
                            const converter = fromBuffer(buffer, {
                                density: 150,        // جودة معقولة وسريعة
                                format: 'jpeg',
                                width: 1200,
                                height: 1600,
                                saveFilename: 'page',
                                savePath: '/tmp'
                            });

                            // نحوّل أول 4 صفحات كحد أقصى (لتجنب timeout)
                            let pages = [];
                            for (let p = 1; p <= 4; p++) {
                                try {
                                    const result = await converter(p, { responseType: 'base64' });
                                    if (result?.base64) pages.push(result.base64);
                                } catch (_) { break; } // توقفنا عند آخر صفحة
                            }

                            if (pages.length === 0) throw new Error('فشل تحويل الصفحات');
                            console.log(`[PDF] تم تحويل ${pages.length} صفحة من "${fileName}"`);

                            const userQ2 = caption || 'اقرأ كل النصوص الموجودة في هذا الملف بدقة كاملة وقدمها منظمة، ثم لخص المحتوى';
                            const prompt2 = userName ? `اسم المستخدم: ${userName}\n${userQ2}` : userQ2;

                            // بناء محتوى الرسالة: كل صفحة كصورة JPG منفصلة
                            const imageContents = pages.map(b64 => ({
                                type: 'image_url',
                                image_url: { url: `data:image/jpeg;base64,${b64}` }
                            }));

                            const res2 = await callMistral({
                                model: 'pixtral-large-latest',
                                messages: [
                                    { role: 'system', content: getSystemPrompt() },
                                    {
                                        role: 'user',
                                        content: [
                                            ...imageContents,
                                            { type: 'text', text: prompt2 }
                                        ]
                                    }
                                ],
                                max_tokens: 2500,
                                temperature: 0.2
                            });

                            stats.totalDocs = (stats.totalDocs || 0) + 1;
                            updateUserStats(sender, 'doc');
                            saveData();
                            if (!userChats[sender]) userChats[sender] = [];
                            userChats[sender].push({ role: 'user',      content: `[أرسل PDF مصوّر: "${fileName}" - ${pages.length} صفحة]` });
                            userChats[sender].push({ role: 'assistant', content: res2 });
                            await reply(res2);
                            await react('✅');
                        } catch (imgErr) {
                            console.error('[PDF scanned]', imgErr.message);
                            await react('❌');
                            await reply(`عذراً، لم أتمكن من قراءة "${fileName}".\nتأكد أن الملف غير محمي بكلمة مرور، أو أرسله كصورة JPG.`);
                        }
                        return;
                    }

                    // حفظ السياق: السؤال + الرد الحقيقي فقط (بدون تكرار)
                    if (!userChats[sender]) userChats[sender] = [];
                    const pdfSummaryCtx = docText.slice(0, 2000);

                    stats.totalDocs = (stats.totalDocs || 0) + 1;
                    updateUserStats(sender, 'doc');
                    saveData();

                    const userQ = caption || 'لخّص هذا الملف بشكل شامل واذكر أهم نقاطه';
                    const res = await askAIWithDoc(docText, userQ, userName);

                    // نضيف للسياق: السؤال + الرد الفعلي فقط
                    userChats[sender].push({
                        role: 'user',
                        content: `[أرسل PDF: "${fileName}" - مقتطف: ${pdfSummaryCtx}...]`
                    });
                    userChats[sender].push({ role: 'assistant', content: res });
                    await reply(res);
                    await react('✅');

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
                    updateUserStats(sender, 'message');
                    saveData();
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

            // أوامر المستخدم (!مساعدة، !مسح، !رصيد، !لغة، !ملخص)
            const isVIPcmd = vipNumbers.includes(sender);
            const handledCmd = await handleUserCommand(body, sender, reply, react, isAdmin, isVIPcmd);
            if (handledCmd) return;

            // anti-spam: منع الإرسال المتسارع جداً
            if (!checkSpam(sender)) {
                await reply('⚠️ أرسلت رسائل بشكل متسارع، انتظر ثوانٍ ثم أعد المحاولة.');
                return;
            }

            // الحد اليومي للرسائل (الأدمن وVIP بلا حدود)
            const isVIP = vipNumbers.includes(sender);
            if (!isAdmin && !isVIP) {
                const quota = checkDailyMessages(sender);
                if (!quota.allowed) {
                    const uStats = userStats[sender] || {};
                    await reply(
                        `🔔 *انتهت رسائلك اليومية*\n\n` +
                        `لقد استنفدت الـ *${quota.limit}* رسالة المجانية لهذا اليوم.\n\n` +
                        `📊 *إحصائياتك الكلية:*\n` +
                        `• إجمالي الرسائل المرسلة: ${uStats.totalSent || 0}\n` +
                        `• الصور المحللة: ${uStats.totalImages || 0}\n` +
                        `• الملفات المعالجة: ${uStats.totalDocs || 0}\n\n` +
                        `🔄 يتجدد رصيدك تلقائياً في منتصف الليل\n\n` +
                        `💬 *للاشتراك بباقة أكبر تواصل مع المطور:*\n` +
                        `👤 wa.me/${ADMIN_NUMBER}`
                    );
                    return;
                }
            }

            await react('👍');

            const maxHist = isVIP ? 60 : MAX_HISTORY; // VIP يحصل على سياق أطول

            if (!userChats[sender]) userChats[sender] = [];

            // سياق أولي إذا كانت الجلسة فارغة
            if (userChats[sender].length === 0 && userName) {
                userChats[sender].push({ role: 'user',      content: `[اسم المستخدم: ${userName}]` });
                userChats[sender].push({ role: 'assistant', content: `أهلاً ${userName}، كيف أستطيع مساعدتك؟` });
            }

            stats.totalMessages++;
            updateUserStats(sender, 'message');
            saveData();
            if (userChats[sender].length >= maxHist)
                userChats[sender] = userChats[sender].slice(-(maxHist - 1));

            userChats[sender].push({ role: 'user', content: body });

            const res = await askAI([
                { role: 'system', content: getSystemPrompt() + (userLanguages[sender] && userLanguages[sender] !== 'ar' ? `\n\nمهم: يجب أن تجيب على هذا المستخدم بلغة "${userLanguages[sender]}" فقط، حتى لو كتب بالعربية.` : '') },
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

// ============================================================
// START
// ============================================================
// تنظيف الذاكرة كل ساعة
setInterval(cleanMemory, 60 * 60_000);





console.log(`🚀 جاري تشغيل ${BOT_NAME}...`);
startQRServer();
startBot();
