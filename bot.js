const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const QRCode = require('qrcode-terminal');
const fs = require('fs');

// ===== CONFIG =====
const MISTRAL_API_KEY = 'fZ0TSrAOJK3cBjkmj461Msqhk90d0HiL';
const ADMIN_NUMBER = '972593850520';
const BOT_NAME = 'MedTerm';

// ===== PERSISTENCE =====
const DATA_FILE = './bot_data.json';

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        }
    } catch (e) {}
    return {
        userNames: {},
        welcomedUsers: {},
        vipNumbers: [],
        reports: [],
        stats: { totalMessages: 0, totalImages: 0, totalDocs: 0, totalMedical: 0 },
        userLanguages: {}
    };
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            userNames,
            welcomedUsers,
            vipNumbers,
            reports,
            stats,
            userLanguages
        }, null, 2));
    } catch (e) {
        console.log('خطأ في حفظ البيانات:', e.message);
    }
}

let { userNames, welcomedUsers, vipNumbers, reports, stats, userLanguages } = loadData();
if (!reports) reports = [];
if (!stats) stats = { totalMessages: 0, totalImages: 0, totalDocs: 0, totalMedical: 0 };
if (!userLanguages) userLanguages = {};

let userChats = {};
let sock = null;

// ===== SYSTEM PROMPT =====
const SYSTEM_PROMPT = `اسمك "${BOT_NAME}"، بوت ذكاء اصطناعي متخصص على واتساب.

شخصيتك (95% جدية ومهنية):
- ردودك دقيقة ومباشرة وبدون أي حشو أو كلام زائد
- اللغة الأساسية عربية فصحى واضحة وسهلة الفهم
- إذا طلب المستخدم لغة أخرى، تحدث معه بها
- تعطي المعلومة الصحيحة الكاملة في أول مرة
- لا تتهاون أبداً في الدقة، المعلومة الخاطئة أخطر من الصمت
- إذا لم تعرف شيئاً قل "لا تتوفر لديّ معلومات كافية حول هذا الموضوع"
- تدعم جميع أرقام دول العالم وتتعامل مع الجميع باحترام
- لو سألك عن اسمك قل: "أنا ${BOT_NAME}، بوت ذكاء اصطناعي"
- ردودك منطقية ومن مصادر موثوقة
- لا تستخدم جداول في ردودك، استخدم النص العادي فقط
- لا تستخدم كلمات أجنبية أو مصطلحات غير مفهومة، عربي وإنجليزي فقط عند الحاجة
- اقرأ سياق المحادثة كاملاً قبل الرد واربط الرسائل ببعضها بذكاء

في المجال الطبي والعلمي:
- معلومات دقيقة 100% موثوقة
- اذكر الجرعات والأدوية بدقة عند الحاجة
- نبّه دائماً بمراجعة الطبيب للحالات الخطيرة أو المزمنة
- في تحليل الصور الطبية: كن متخصصاً ودقيقاً واطلب مراجعة متخصص للتأكيد

تذكر: اسم المستخدم موجود في السياق، استخدمه أحياناً بشكل طبيعي.`;

// ===== MEDICAL IMAGE PROMPT =====
const MEDICAL_IMAGE_PROMPT = `أنت طبيب متخصص ومحلل صور طبية خبير. مهمتك تحليل الصور الطبية بدقة عالية.

عند تحليل الصورة الطبية:
1. تحديد نوع الصورة: أشعة X أو CT أو MRI أو تحليل دم أو تقرير مخبري
2. الملاحظات الرئيسية: ما تلاحظه بوضوح في الصورة
3. التفسير الطبي: ماذا تعني هذه الملاحظات
4. المؤشرات الطبيعية أو غير الطبيعية: هل القيم ضمن المعدل الطبيعي
5. التوصية: ما الخطوة التالية المقترحة

قواعد مهمة:
- كن دقيقاً ومهنياً في وصفك
- اذكر أي نتيجة غير طبيعية بوضوح
- لا تستخدم جداول، اكتب كل شيء كنص عادي
- دائماً في النهاية: "تنبيه: هذا التحليل للمعلومة فقط، يجب مراجعة طبيب متخصص للتشخيص النهائي"`;

// ===== AI FUNCTIONS =====
async function askAI(messages) {
    try {
        const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
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
        });

        const data = await response.json();
        if (!data?.choices?.[0]) throw new Error('No response');
        return data.choices[0].message.content;

    } catch (e) {
        console.log("AI ERROR:", e.message);
        return "عذراً، حدث خطأ تقني. يرجى المحاولة مرة أخرى.";
    }
}

// ===== MEDICAL IMAGE DETECTION =====
function isMedicalImage(text) {
    const keywords = /أشعة|xray|x-ray|mri|رنين|ct scan|تحليل دم|فحص دم|صورة طبية|تقرير طبي|مختبر|مخبر|lab|blood test|صورة صدر|قلب|كلية|كبد|دماغ|brain|lung|kidney|liver|heart|ultrasound|سونار|إيكو|echo|ecg|ekg|نتائج|results|تقرير|فحص/i;
    return keywords.test(text || '');
}

async function askAIWithImage(base64Image, userQuestion, userName) {
    try {
        const isMedical = isMedicalImage(userQuestion);
        const systemToUse = isMedical ? MEDICAL_IMAGE_PROMPT : SYSTEM_PROMPT;
        const questionText = userQuestion || (isMedical ? 'حلل هذه الصورة الطبية بالتفصيل' : 'صف ما تراه في هذه الصورة بالتفصيل');

        const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
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
        });

        const data = await response.json();
        if (!data?.choices?.[0]) throw new Error('AI image error');
        return data.choices[0].message.content;

    } catch (e) {
        console.log("AI IMAGE ERROR:", e.message);
        return "عذراً، لم أتمكن من تحليل الصورة. يرجى المحاولة مرة أخرى.";
    }
}

// ===== BROADCAST TO ALL USERS =====
async function broadcastToAll(text) {
    const allUsers = Object.keys(welcomedUsers);
    let sent = 0;
    let failed = 0;

    for (const num of allUsers) {
        try {
            await sock.sendMessage(`${num}@s.whatsapp.net`, { text });
            sent++;
            await new Promise(r => setTimeout(r, 800)); // تأخير لتجنب الحظر
        } catch (e) {
            failed++;
        }
    }
    return { sent, failed, total: allUsers.length };
}

// ===== PRAYER TIMES (بتوقيت فلسطين - القدس) =====
// مواعيد تقريبية - يمكن تعديلها حسب المنطقة
const PRAYER_SCHEDULE = [
    { name: 'الفجر',    hour: 4,  minute: 30 },
    { name: 'الظهر',    hour: 12, minute: 15 },
    { name: 'العصر',    hour: 15, minute: 30 },
    { name: 'المغرب',   hour: 18, minute: 15 },
    { name: 'العشاء',   hour: 20, minute: 0  }
];

// ===== DHIKR MESSAGES =====
const DHIKR_MESSAGES = [
    "سبحان الله وبحمده، سبحان الله العظيم\n\nاللهم أعنّا على ذكرك وشكرك وحسن عبادتك",
    "أستغفر الله العظيم الذي لا إله إلا هو الحي القيوم وأتوب إليه\n\nاستغفروا ربكم إنه كان غفاراً",
    "لا إله إلا الله وحده لا شريك له، له الملك وله الحمد وهو على كل شيء قدير\n\nأكثروا من هذا الذكر في صباحكم ومسائكم",
    "اللهم صلِّ على محمد وعلى آل محمد كما صليت على إبراهيم وعلى آل إبراهيم إنك حميد مجيد\n\nأكثروا من الصلاة على النبي في كل وقت",
    "سبحان الله والحمد لله ولا إله إلا الله والله أكبر\n\nهذه الكلمات أحب إلى الله من كل ما طلعت عليه الشمس",
    "رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً وَفِي الآخِرَةِ حَسَنَةً وَقِنَا عَذَابَ النَّارِ\n\nاللهم آمين",
];

const SALAH_ON_PROPHET = [
    "اللهم صلِّ على محمد وعلى آل محمد\nكما صليت على إبراهيم وعلى آل إبراهيم\nإنك حميد مجيد",
    "اللهم صلِّ وسلِّم وبارك على نبينا محمد\nمن صلّى عليّ مرة صلى الله عليه بها عشراً",
    "اللهم صلِّ على محمد النبي الأمي وعلى آله وصحبه وسلِّم\nأكثروا من الصلاة على النبي يوم الجمعة",
];

// ===== WELCOME MESSAGE =====
function buildWelcomeMessage(name) {
    const firstName = name ? name.split(' ')[0] : null;
    const greeting = firstName ? `أهلاً ${firstName}` : `أهلاً`;

    return `${greeting} 👋

أنا *${BOT_NAME}*، بوت ذكاء اصطناعي على واتساب.

أستطيع مساعدتك في:
• الإجابة على أي سؤال
• تحليل الصور والصور الطبية
• معلومات طبية وعلمية دقيقة

للإبلاغ عن مشكلة اكتب: *!بلاغ* ثم وصف المشكلة

اسأل بدون تردد 🤝`;
}

// ===== SCHEDULERS =====
function startSchedulers() {

    // فحص أوقات الصلاة كل دقيقة
    setInterval(async () => {
        if (!sock) return;
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();

        for (const prayer of PRAYER_SCHEDULE) {
            if (prayer.hour === hour && prayer.minute === minute) {
                const msg = `🕌 *حان وقت صلاة ${prayer.name}*\n\nاللهم اجعلنا من المحافظين على الصلوات\nحي على الصلاة، حي على الفلاح`;
                await broadcastToAll(msg).catch(() => {});
                console.log(`📿 تم إرسال تنبيه صلاة ${prayer.name}`);
            }
        }
    }, 60 * 1000);

    // ذكر واستغفار كل ساعة
    setInterval(async () => {
        if (!sock) return;
        const dhikr = DHIKR_MESSAGES[Math.floor(Math.random() * DHIKR_MESSAGES.length)];
        const msg = `📿 *ذكر الساعة*\n\n${dhikr}`;
        await broadcastToAll(msg).catch(() => {});
        console.log('📿 تم إرسال الذكر');
    }, 60 * 60 * 1000);

    // صلاة على النبي كل ساعتين
    setInterval(async () => {
        if (!sock) return;
        const salah = SALAH_ON_PROPHET[Math.floor(Math.random() * SALAH_ON_PROPHET.length)];
        const msg = `💚 *صلاة على النبي ﷺ*\n\n${salah}`;
        await broadcastToAll(msg).catch(() => {});
        console.log('💚 تم إرسال الصلاة على النبي');
    }, 2 * 60 * 60 * 1000);
}

// ===== MAIN BOT =====
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version,
        auth: state,
        browser: Browsers.macOS('Desktop')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            console.log('\n📱 امسح QR التالي:\n');
            QRCode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('✅ البوت جاهز وشغال!');
            startSchedulers();
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log('❌ انقطع الاتصال، الكود:', code);
            if (shouldReconnect) {
                console.log('إعادة الاتصال خلال 5 ثواني...');
                setTimeout(startBot, 5000);
            } else {
                console.log('تم تسجيل الخروج، يجب ربط الجلسة من جديد.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;

            const msg = messages?.[0];
            if (!msg?.message || msg?.key?.fromMe) return;

            const message = msg.message || {};

            const msgType = (() => {
                const keys = Object.keys(message || {});
                if (!keys.length) return null;
                for (let k of keys) {
                    if (message[k] !== undefined && message[k] !== null && k !== 'messageContextInfo') return k;
                }
                return null;
            })();

            if (!msgType) return;
            if (['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'reactionMessage'].includes(msgType)) return;

            const jid = msg.key?.remoteJid;
            if (!jid) return;

            const isGroup = jid.endsWith('@g.us');

            const sender = msg.key?.participant
                ? msg.key.participant.replace('@s.whatsapp.net', '').replace('@lid', '')
                : jid.replace('@s.whatsapp.net', '').replace('@lid', '').replace('@g.us', '');

            const body =
                (typeof message?.conversation === 'string' && message.conversation) ||
                (typeof message?.extendedTextMessage?.text === 'string' && message.extendedTextMessage.text) ||
                (typeof message?.imageMessage?.caption === 'string' && message.imageMessage.caption) ||
                (typeof message?.documentMessage?.caption === 'string' && message.documentMessage.caption) ||
                (typeof message?.videoMessage?.caption === 'string' && message.videoMessage.caption) ||
                '';

            const safeBody = body.trim();
            const isAdmin = sender === ADMIN_NUMBER;

            console.log(`📨 من: ${sender} | النوع: ${msgType}`);

            const reply = async (text) => {
                try {
                    await sock.sendMessage(jid, { text }, { quoted: msg });
                } catch (e) {
                    console.log('خطأ في الرد:', e.message);
                }
            };

            const react = async (emoji) => {
                try {
                    await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
                } catch {}
            };

            // ===== أوامر الأدمن =====
            if (isAdmin) {
                // بث رسالة لجميع المستخدمين
                if (safeBody.startsWith('!بث ') || safeBody.startsWith('!broadcast ')) {
                    const broadcastText = safeBody.split(' ').slice(1).join(' ').trim();
                    if (!broadcastText) {
                        await reply('اكتب الرسالة بعد الأمر\nمثال: !بث مرحباً بالجميع');
                        return;
                    }
                    await reply('⏳ جاري إرسال الرسالة للجميع...');
                    const result = await broadcastToAll(`📢 *رسالة من الإدارة*\n\n${broadcastText}`);
                    await reply(`✅ تم الإرسال\nالمُرسَل: ${result.sent}\nفشل: ${result.failed}\nالإجمالي: ${result.total}`);
                    return;
                }

                if (safeBody.startsWith('!vip ')) {
                    const num = safeBody.split(' ')[1]?.trim();
                    if (num && !vipNumbers.includes(num)) { vipNumbers.push(num); saveData(); }
                    await reply('✅ تم إضافة VIP');
                    return;
                }

                if (safeBody.startsWith('!حذف ')) {
                    const num = safeBody.split(' ')[1]?.trim();
                    vipNumbers = vipNumbers.filter(n => n !== num);
                    saveData();
                    await reply('تم الحذف من VIP');
                    return;
                }

                if (safeBody === '!قائمة') {
                    await reply(vipNumbers.length ? `قائمة VIP:\n${vipNumbers.join('\n')}` : 'لا يوجد أرقام VIP حالياً');
                    return;
                }

                if (safeBody === '!احصائيات') {
                    const activeUsers = Object.keys(userChats).length;
                    const welcomedCount = Object.keys(welcomedUsers).length;
                    await reply(
                        `إحصائيات ${BOT_NAME}:\n\n` +
                        `المستخدمون المسجلون: ${welcomedCount}\n` +
                        `المستخدمون النشطون: ${activeUsers}\n` +
                        `أرقام VIP: ${vipNumbers.length}\n\n` +
                        `الرسائل النصية: ${stats.totalMessages}\n` +
                        `الصور المحللة: ${stats.totalImages}\n` +
                        `الصور الطبية: ${stats.totalMedical}\n` +
                        `البلاغات: ${reports.length}`
                    );
                    return;
                }

                if (safeBody.startsWith('!مسح ')) {
                    const num = safeBody.split(' ')[1]?.trim();
                    delete userChats[num];
                    delete welcomedUsers[num];
                    saveData();
                    await reply('تم مسح محادثة ' + num);
                    return;
                }

                if (safeBody === '!مسح_كل') {
                    userChats = {};
                    await reply('تم مسح كل الجلسات');
                    return;
                }

                if (safeBody === '!بلاغات') {
                    if (!reports.length) {
                        await reply('لا يوجد بلاغات حالياً');
                    } else {
                        const last10 = reports.slice(-10).reverse();
                        let txt = `آخر ${last10.length} بلاغات:\n\n`;
                        last10.forEach((r, i) => {
                            txt += `${i+1}. ${r.name || r.sender}\n${r.sender}\n${r.text}\n${r.time}\n\n`;
                        });
                        await reply(txt);
                    }
                    return;
                }

                if (safeBody === '!مساعدة') {
                    await reply(
                        `أوامر الأدمن:\n\n` +
                        `!بث [رسالة] - إرسال رسالة لجميع المستخدمين\n` +
                        `!vip [رقم] - إضافة VIP\n` +
                        `!حذف [رقم] - حذف VIP\n` +
                        `!قائمة - عرض VIP\n` +
                        `!احصائيات - إحصائيات البوت\n` +
                        `!بلاغات - عرض البلاغات\n` +
                        `!مسح [رقم] - مسح محادثة\n` +
                        `!مسح_كل - مسح كل الجلسات`
                    );
                    return;
                }
            }

            await react('👍');

            // ===== نظام الإبلاغ =====
            if (safeBody.startsWith('!بلاغ ') || safeBody.startsWith('!مشكلة ')) {
                const reportText = safeBody.split(' ').slice(1).join(' ').trim();
                if (!reportText) {
                    await reply('اكتب المشكلة بعد الأمر\nمثال: !بلاغ البوت لم يرد بشكل صحيح');
                    return;
                }
                const report = {
                    sender,
                    name: userNames[sender] || 'غير معروف',
                    text: reportText,
                    time: new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Jerusalem' })
                };
                reports.push(report);
                if (reports.length > 500) reports = reports.slice(-500);
                saveData();

                try {
                    await sock.sendMessage(`${ADMIN_NUMBER}@s.whatsapp.net`, {
                        text: `بلاغ جديد\nالمستخدم: ${report.name}\nالرقم: ${report.sender}\nالمشكلة: ${report.text}\nالوقت: ${report.time}`
                    });
                } catch {}

                await reply('تم استلام بلاغك وسيتم مراجعته. شكراً على تواصلك.');
                await react('✅');
                return;
            }

            // ===== استخراج اسم المستخدم =====
            let userName = userNames[sender];
            if (!userName && msg.pushName?.trim()) {
                userName = msg.pushName.trim();
                userNames[sender] = userName;
                saveData();
            }

            // ===== رسالة الترحيب =====
            if (!welcomedUsers[sender]) {
                welcomedUsers[sender] = true;
                if (!userName && msg.pushName) { userName = msg.pushName.trim(); userNames[sender] = userName; }
                saveData();
                await reply(buildWelcomeMessage(userName));
                if (!userChats[sender]) userChats[sender] = [];
                if (userName) {
                    userChats[sender].push({ role: 'user', content: `[اسم المستخدم: ${userName}]` });
                    userChats[sender].push({ role: 'assistant', content: `أهلاً ${userName}، كيف أستطيع مساعدتك؟` });
                }
                return;
            }

            // تحديث الاسم إذا تغير
            if (msg.pushName?.trim() && msg.pushName.trim() !== userNames[sender]) {
                userNames[sender] = msg.pushName.trim();
                userName = userNames[sender];
                saveData();
            }

            // ===== معالجة الصور =====
            if (msgType === 'imageMessage') {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: { level: 'silent', child: () => ({ level: 'silent' }) } });
                    const base64 = buffer.toString('base64');
                    const isMed = isMedicalImage(safeBody);
                    stats.totalImages++;
                    if (isMed) stats.totalMedical++;
                    saveData();
                    const res = await askAIWithImage(base64, safeBody, userName);
                    await reply(res);
                    await react('✅');
                } catch (e) {
                    await reply('لم أتمكن من تحليل الصورة، يرجى المحاولة مرة أخرى.');
                    await react('❌');
                }
                return;
            }

            // ===== الملفات غير مدعومة =====
            if (msgType === 'documentMessage') {
                await reply(
                    `عذراً، الملفات غير مدعومة حالياً.\n\n` +
                    `ما يدعمه ${BOT_NAME}:\n` +
                    `الرسائل النصية\n` +
                    `الصور وتحليلها\n` +
                    `الصور الطبية\n\n` +
                    `يمكنك نسخ محتوى الملف وإرساله كنص.`
                );
                await react('ℹ️');
                return;
            }

            // ===== الفيديو غير مدعوم =====
            if (msgType === 'videoMessage') {
                await reply(
                    `عذراً، الفيديوهات غير مدعومة حالياً.\n\n` +
                    `ما يدعمه ${BOT_NAME}:\n` +
                    `الرسائل النصية\n` +
                    `الصور وتحليلها\n` +
                    `الصور الطبية`
                );
                await react('ℹ️');
                return;
            }

            // ===== الصوت غير مدعوم =====
            if (msgType === 'audioMessage' || msgType === 'pttMessage') {
                await reply(
                    `عذراً، الرسائل الصوتية غير مدعومة حالياً.\n\n` +
                    `ما يدعمه ${BOT_NAME}:\n` +
                    `الرسائل النصية\n` +
                    `الصور وتحليلها\n` +
                    `الصور الطبية`
                );
                await react('ℹ️');
                return;
            }

            // ===== الرسائل النصية =====
            if (!safeBody) return;

            if (!userChats[sender]) userChats[sender] = [];

            // إضافة الاسم للسياق إذا لم يكن موجوداً
            if (userName && userChats[sender].length === 0) {
                userChats[sender].push({ role: 'user', content: `[اسم المستخدم: ${userName}]` });
                userChats[sender].push({ role: 'assistant', content: `أهلاً ${userName}، كيف أستطيع مساعدتك؟` });
            }

            userChats[sender].push({ role: 'user', content: safeBody });
            stats.totalMessages++;

            // الاحتفاظ بآخر 30 رسالة لسياق كامل
            if (userChats[sender].length > 30)
                userChats[sender] = userChats[sender].slice(-30);

            const res = await askAI([
                { role: 'system', content: SYSTEM_PROMPT },
                ...userChats[sender]
            ]);

            userChats[sender].push({ role: 'assistant', content: res });

            await reply(res);
            await react('✅');

        } catch (error) {
            console.log('خطأ عام:', error.message);
            try {
                await sock.sendMessage(msg.key.remoteJid, {
                    text: 'حدث خطأ تقني، يرجى المحاولة مرة أخرى.'
                }, { quoted: msg });
            } catch {}
        }
    });
}

// ===== START =====
console.log(`🚀 جاري تشغيل ${BOT_NAME}...`);
startBot();
