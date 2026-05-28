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

// ===== WORK HOURS =====
// البوت شغال من 7 صباحاً لـ 7 مساءً
function isWorkingHours() {
    const now = new Date();
    const hour = now.getHours();
    return hour >= 7 && hour < 19;
}

// ===== PERSISTENCE =====
const DATA_FILE = './bot_data.json';

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        }
    } catch (e) {
        console.log('تحميل بيانات جديدة...');
    }
    return { userNames: {}, welcomedUsers: {}, vipNumbers: [], reports: [], stats: { totalMessages: 0, totalImages: 0, totalDocs: 0, totalMedical: 0 } };
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            userNames,
            welcomedUsers,
            vipNumbers,
            reports,
            stats
        }, null, 2));
    } catch (e) {
        console.log('خطأ في حفظ البيانات:', e.message);
    }
}

let { userNames, welcomedUsers, vipNumbers, reports, stats } = loadData();
if (!reports) reports = [];
if (!stats) stats = { totalMessages: 0, totalImages: 0, totalDocs: 0, totalMedical: 0 };
let userChats = {};
let sock = null;


// ===== SYSTEM PROMPT =====
const SYSTEM_PROMPT = `اسمك "نادر"، مساعد ذكي ومتخصص على واتساب.

🎯 شخصيتك الأساسية (90% صارم وجدي):
- ردودك مهنية ودقيقة ومباشرة دون أي حشو أو كلام فاضي
- تتكلم بعامية عربية واضحة لكن بأسلوب جدي محترم
- تعطي المعلومة كاملة وصحيحة في أول مرة
- لا تتهاون في الدقة أبداً، المعلومة الخاطئة أخطر من الصمت
- لو ما بتعرف شي قول "ما عندي معلومة كافية عن هاد الموضوع" بدل ما تخمن
- لو حدا حكيلك بالإنجليزي رد عليه بالإنجليزي بنفس الأسلوب الجدي
- لو سألك عن اسمك قلو: "أنا نادر" بدون ما تزيد

😄 جانب خفيف (10% فقط - مزاح خفيف بالوقت المناسب):
- أحياناً ممكن تضيف تعليق خفيف أو مزحة صغيرة بس بعد ما تعطي الإجابة الجدية
- المزاح يكون لطيف ومناسب، مش في المواقف الحساسة أو الطبية الخطيرة
- لا تبالغ في المزاح، جملة واحدة كافية كل فترة

في المجال الطبي والعلمي:
- معلومات دقيقة 100% موثوقة
- اذكر الجرعات والأدوية بدقة عند الحاجة
- نبّه دائماً بمراجعة الطبيب للحالات الخطيرة أو المزمنة
- في تحليل الصور الطبية: كن متخصصاً ودقيقاً، اذكر الملاحظات بوضوح واطلب دائماً مراجعة متخصص للتأكيد

في باقي المجالات:
- إجابات علمية ودقيقة ومنظمة
- أمثلة عملية عند الحاجة
- لا تطول الرد بلا داعٍ

تذكر: اسم المستخدم موجود في السياق، استخدمه أحياناً بشكل طبيعي.`;

// ===== MEDICAL IMAGE SYSTEM PROMPT =====
const MEDICAL_IMAGE_PROMPT = `أنت طبيب متخصص ومحلل صور طبية خبير. مهمتك تحليل الصور الطبية (أشعة، تحاليل، صور مجهرية، تقارير طبية) بدقة عالية.

عند تحليل الصورة الطبية:
1. **تحديد نوع الصورة**: أشعة X، CT، MRI، تحليل دم، تقرير مخبري، وغيره
2. **الملاحظات الرئيسية**: ما تلاحظه بوضوح في الصورة
3. **التفسير الطبي**: ماذا تعني هذه الملاحظات
4. **مؤشرات طبيعية/غير طبيعية**: هل القيم أو الصورة ضمن المعدل الطبيعي
5. **التوصية**: ما الخطوة التالية المقترحة

قواعد مهمة:
- كن دقيقاً ومهنياً في وصفك
- اذكر أي نتيجة غير طبيعية بوضوح
- دائماً في النهاية: "⚠️ هاد التحليل للمعلومة فقط، لازم تراجع طبيب متخصص للتشخيص النهائي"
- لا تتهرب من الإجابة لأسباب غير طبية`;

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
                max_tokens: 1000,
                temperature: 0.8
            })
        });

        const data = await response.json();
        if (!data?.choices?.[0]) throw new Error('No response from AI');
        return data.choices[0].message.content;

    } catch (e) {
        console.log("AI ERROR:", e.message);
        return "عندي مشكلة تقنية هلق، جرب مرة ثانية 😅";
    }
}

// ===== MEDICAL IMAGE DETECTION =====
function isMedicalImage(text) {
    const medicalKeywords = /أشعة|xray|x-ray|x ray|mri|رنين|ct scan|سكان|تحليل دم|فحص دم|صورة طبية|تقرير طبي|مختبر|مخبر|lab|blood test|صورة صدر|قلب|كلية|كبد|دماغ|brain|lung|kidney|liver|heart|ultrasound|سونار|إيكو|echo|تخطيط|ecg|ekg|نتائج|results|تقرير|report|فحص/i;
    return medicalKeywords.test(text || '');
}

async function askAIWithImage(base64Image, userQuestion, userName) {
    try {
        const isMedical = isMedicalImage(userQuestion);
        const systemToUse = isMedical ? MEDICAL_IMAGE_PROMPT : SYSTEM_PROMPT;
        const questionText = userQuestion || (isMedical ? 'حلل هذه الصورة الطبية بالتفصيل' : 'احكيلي شو في هالصورة بالتفصيل');

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
                            {
                                type: 'image_url',
                                image_url: { url: `data:image/jpeg;base64,${base64Image}` }
                            },
                            {
                                type: 'text',
                                text: userName ? `اسم المستخدم: ${userName}\n${questionText}` : questionText
                            }
                        ]
                    }
                ],
                max_tokens: isMedical ? 2000 : 1500,
                temperature: isMedical ? 0.3 : 0.7
            })
        });

        const data = await response.json();
        if (!data?.choices?.[0]) throw new Error('AI image error');
        return data.choices[0].message.content;

    } catch (e) {
        console.log("AI IMAGE ERROR:", e.message);
        return "ما قدرت أحلل الصورة هلق، جرب مرة ثانية 😕";
    }
}

async function analyzeDocument(text, userQuestion, userName) {
    try {
        const prompt = `${userName ? `اسم المستخدم: ${userName}\n` : ''}المستخدم بعت ملف وسأل: "${userQuestion || 'احكيلي عن هالملف'}"

محتوى الملف:
${text.slice(0, 6000)}

اشرح الملف وجاوب على سؤاله بشكل مفيد.`;

        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
        ];

        return await askAI(messages);
    } catch (e) {
        return "ما قدرت أقرأ الملف، تأكد إنو ملف نصي 📄";
    }
}

// ===== GET USER NAME FROM WHATSAPP =====
async function getUserName(jid) {
    try {
        // محاولة جلب الاسم من جهات الاتصال
        if (sock?.store?.contacts) {
            const contact = sock.store.contacts[jid];
            if (contact?.name || contact?.notify) {
                return contact.name || contact.notify;
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

// ===== WELCOME MESSAGE =====
function buildWelcomeMessage(name) {
    const firstName = name ? name.split(' ')[0] : null;
    const greeting = firstName ? `أهلاً ${firstName}! 👋` : `أهلاً! 👋`;

    return `${greeting}

أنا *نادر*، مساعدك الذكي على واتساب. 🤖

قادر أساعدك في:
• أي سؤال أو استفسار 💬
• تحليل الصور والصور الطبية 🏥
• قراءة وشرح الملفات 📄
• معلومات طبية وعلمية دقيقة
• والكثير غيرها...

شغال من *7 الصبح لـ 7 المسا* ⏰
لو صار أي مشكلة: اكتب *!بلاغ* ووصف المشكلة

اسأل بدون تردد! 😄

---
_إذا عجبك البوت، شاركه مع أصحابك عشان يستفيدوا هم كمان_ 🙌`;
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

            // استخراج نوع الرسالة
            const msgType = (() => {
                const keys = Object.keys(message || {});
                if (!Array.isArray(keys) || keys.length === 0) return null;
                for (let k of keys) {
                    if (
                        message[k] !== undefined &&
                        message[k] !== null &&
                        k !== 'messageContextInfo'
                    ) return k;
                }
                return null;
            })();

            if (!msgType) return;

            if (
                msgType === 'protocolMessage' ||
                msgType === 'senderKeyDistributionMessage' ||
                msgType === 'messageContextInfo' ||
                msgType === 'reactionMessage'
            ) return;

            const jid = msg.key?.remoteJid;
            if (!jid) return;

            const isGroup = jid.endsWith('@g.us');

            const sender = msg.key?.participant
                ? msg.key.participant.replace('@s.whatsapp.net', '').replace('@lid', '')
                : jid.replace('@s.whatsapp.net', '').replace('@lid', '').replace('@g.us', '');

            // استخراج الرسالة النصية
            const body =
                (typeof message?.conversation === 'string' && message.conversation) ||
                (typeof message?.extendedTextMessage?.text === 'string' && message.extendedTextMessage.text) ||
                (typeof message?.imageMessage?.caption === 'string' && message.imageMessage.caption) ||
                (typeof message?.documentMessage?.caption === 'string' && message.documentMessage.caption) ||
                (typeof message?.videoMessage?.caption === 'string' && message.videoMessage.caption) ||
                '';

            const safeBody = body.trim();

            const isAdmin = sender === ADMIN_NUMBER;

            console.log(`📨 رسالة من: ${sender} | النوع: ${msgType} | المجموعة: ${isGroup}`);

            const reply = async (text) => {
                try {
                    await sock.sendMessage(jid, { text }, { quoted: msg });
                } catch (e) {
                    console.log('خطأ في الرد:', e.message);
                }
            };

            const react = async (emoji) => {
                try {
                    await sock.sendMessage(jid, {
                        react: { text: emoji, key: msg.key }
                    });
                } catch {}
            };

            // ===== التحقق من ساعات العمل (ليس للأدمن) =====
            if (!isAdmin && !isWorkingHours()) {
                if (!userChats[sender + '_offhours_notified']) {
                    userChats[sender + '_offhours_notified'] = true;
                    await reply(
                        `عذراً، أنا بشتغل من *7 الصبح لـ 7 المسا* فقط ⏰\n\nجرب تتواصل معي خلال هالأوقات وأنا هون! 😊`
                    );
                }
                return;
            }
            // تصفير إشعار خارج أوقات العمل عند العودة
            delete userChats[sender + '_offhours_notified'];

            // ===== ADMIN COMMANDS =====
            if (isAdmin) {
                if (safeBody.startsWith('!vip ')) {
                    const num = safeBody.split(' ')[1]?.trim();
                    if (num && !vipNumbers.includes(num)) {
                        vipNumbers.push(num);
                        saveData();
                    }
                    await reply('✅ تم إضافة VIP');
                    return;
                }

                if (safeBody.startsWith('!حذف ') || safeBody.startsWith('!دل ')) {
                    const num = safeBody.split(' ')[1]?.trim();
                    vipNumbers = vipNumbers.filter(n => n !== num);
                    saveData();
                    await reply('🗑️ تم الحذف من VIP');
                    return;
                }

                if (safeBody === '!قائمة') {
                    await reply(vipNumbers.length
                        ? `قائمة VIP:\n${vipNumbers.join('\n')}`
                        : 'ما في أرقام VIP حالياً');
                    return;
                }

                if (safeBody === '!احصائيات') {
                    const activeUsers = Object.keys(userChats).filter(k => !k.includes('_')).length;
                    const welcomedCount = Object.keys(welcomedUsers).length;
                    await reply(
                        `📊 *إحصائيات البوت:*\n\n` +
                        `👥 مستخدمين مسجلين: ${welcomedCount}\n` +
                        `🟢 مستخدمين نشطين الآن: ${activeUsers}\n` +
                        `⭐ أرقام VIP: ${vipNumbers.length}\n\n` +
                        `💬 رسائل نصية: ${stats.totalMessages}\n` +
                        `🖼️ صور محللة: ${stats.totalImages}\n` +
                        `🏥 صور طبية: ${stats.totalMedical}\n` +
                        `📄 ملفات: ${stats.totalDocs}\n` +
                        `🚨 بلاغات: ${reports.length}`
                    );
                    return;
                }

                if (safeBody.startsWith('!مسح ')) {
                    const num = safeBody.split(' ')[1]?.trim();
                    delete userChats[num];
                    delete welcomedUsers[num];
                    saveData();
                    await reply('🗑️ تم مسح محادثة ' + num);
                    return;
                }

                if (safeBody === '!مسح_كل') {
                    userChats = {};
                    await reply('✅ تم مسح كل الجلسات');
                    return;
                }

                if (safeBody === '!مساعدة') {
                    await reply(
                        `🛠️ أوامر الأدمن:\n` +
                        `!vip [رقم] - إضافة VIP\n` +
                        `!حذف [رقم] - حذف VIP\n` +
                        `!قائمة - عرض VIP\n` +
                        `!احصائيات - إحصائيات البوت\n` +
                        `!بلاغات - عرض البلاغات الأخيرة\n` +
                        `!مسح [رقم] - مسح محادثة\n` +
                        `!مسح_كل - مسح كل الجلسات`
                    );
                    return;
                }

                if (safeBody === '!بلاغات') {
                    if (!reports.length) {
                        await reply('📭 ما في بلاغات حالياً');
                    } else {
                        const last10 = reports.slice(-10).reverse();
                        let msg = `📋 آخر ${last10.length} بلاغات:\n\n`;
                        last10.forEach((r, i) => {
                            msg += `${i+1}. 👤 ${r.name || r.sender}\n📞 ${r.sender}\n📝 ${r.text}\n🕐 ${r.time}\n\n`;
                        });
                        await reply(msg);
                    }
                    return;
                }
            }

            await react('👍');

            // ===== نظام الإبلاغ عن مشكلة =====
            if (safeBody.startsWith('!بلاغ ') || safeBody.startsWith('!مشكلة ') || safeBody.toLowerCase().startsWith('!report ')) {
                const reportText = safeBody.split(' ').slice(1).join(' ').trim();
                if (!reportText) {
                    await reply('❓ اكتب المشكلة بعد الأمر، مثال:\n!بلاغ البوت ما رد عليّ بشكل صحيح');
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

                // إشعار الأدمن
                try {
                    await sock.sendMessage(`${ADMIN_NUMBER}@s.whatsapp.net`, {
                        text: `🚨 *بلاغ جديد*\n👤 ${report.name}\n📞 ${report.sender}\n📝 ${report.text}\n🕐 ${report.time}`
                    });
                } catch {}

                await reply('✅ تم استلام بلاغك وسيتم مراجعته. شكراً على تواصلك!');
                await react('✅');
                return;
            }

            // ===== استخراج اسم المستخدم =====
            let userName = userNames[sender];

            if (!userName) {
                // محاولة جلب الاسم من push name أو الـ contact info
                const pushName = msg.pushName;
                if (pushName && pushName.trim()) {
                    userName = pushName.trim();
                    userNames[sender] = userName;
                    saveData();
                    console.log(`💾 حفظ اسم: ${userName} لـ ${sender}`);
                }
            }

            // ===== رسالة الترحيب (مرة واحدة فقط) =====
            if (!welcomedUsers[sender]) {
                welcomedUsers[sender] = true;
                saveData();

                // تحديث الاسم إذا وصل مع أول رسالة
                if (!userName && msg.pushName) {
                    userName = msg.pushName.trim();
                    userNames[sender] = userName;
                    saveData();
                }

                await reply(buildWelcomeMessage(userName));

                // تهيئة الجلسة مع معلومة الاسم
                if (!userChats[sender]) userChats[sender] = [];
                if (userName) {
                    userChats[sender].push({
                        role: 'user',
                        content: `[معلومة: اسم هذا المستخدم هو "${userName}"]`
                    });
                    userChats[sender].push({
                        role: 'assistant',
                        content: `أهلاً ${userName}! كيف أقدر أساعدك؟ 😊`
                    });
                }
                return;
            }

            // تحديث الاسم إذا تغير
            if (msg.pushName && msg.pushName.trim() && msg.pushName.trim() !== userNames[sender]) {
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
                    console.log('خطأ في معالجة الصورة:', e.message);
                    await reply('ما قدرت أحمل الصورة، جرب مرة ثانية 😕');
                    await react('❌');
                }
                return;
            }

            // ===== معالجة الفيديو بالتعليق =====
            if (msgType === 'videoMessage') {
                if (safeBody) {
                    // لو في سؤال على الفيديو
                    if (!userChats[sender]) userChats[sender] = [];
                    userChats[sender].push({
                        role: 'user',
                        content: `المستخدم بعت فيديو وسأل: "${safeBody}". أخبره إنك ما تقدر تشوف الفيديو بس ممكن تساعده بأي سؤال ثاني.`
                    });
                    const res = await askAI([
                        { role: 'system', content: SYSTEM_PROMPT },
                        ...userChats[sender]
                    ]);
                    userChats[sender].push({ role: 'assistant', content: res });
                    await reply(res);
                } else {
                    await reply("🎬 مشان الله، ما أقدر أشوف الفيديوهات حالياً، بس لو عندك سؤال أنا هون!");
                }
                await react('✅');
                return;
            }

            // ===== معالجة الملفات =====
            if (msgType === 'documentMessage') {
                try {
                    stats.totalDocs++;
                    saveData();
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: { level: 'silent', child: () => ({ level: 'silent' }) } });
                    const mimeType = message.documentMessage?.mimetype || '';
                    let fileText = '';

                    if (mimeType.includes('text') || mimeType.includes('json') || mimeType.includes('xml')) {
                        fileText = buffer.toString('utf-8');
                    } else if (mimeType.includes('pdf')) {
                        fileText = `[ملف PDF - حجم: ${(buffer.length / 1024).toFixed(1)} KB]\n${buffer.toString('utf-8', 0, 3000)}`;
                    } else {
                        fileText = buffer.toString('utf-8');
                    }

                    if (!userChats[sender]) userChats[sender] = [];

                    const question_text = safeBody || 'احكيلي عن هالملف وشو مهم فيه';

                    userChats[sender].push({
                        role: 'user',
                        content: `${userName ? `اسمي ${userName}. ` : ''}بعتلك ملف وبدي: ${question_text}\n\n--- محتوى الملف ---\n${fileText.slice(0, 6000)}`
                    });

                    const res = await askAI([
                        { role: 'system', content: SYSTEM_PROMPT },
                        ...userChats[sender]
                    ]);

                    userChats[sender].push({ role: 'assistant', content: res });

                    if (userChats[sender].length > 30)
                        userChats[sender] = userChats[sender].slice(-30);

                    await reply(res);
                    await react('✅');
                } catch (e) {
                    console.log('خطأ في معالجة الملف:', e.message);
                    await reply('ما قدرت أقرأ الملف، تأكد إنو ملف نصي أو PDF 📄');
                    await react('❌');
                }
                return;
            }

            // ===== رسائل الصوت =====
            if (msgType === 'audioMessage' || msgType === 'pttMessage') {
                await reply("🎤 الرسائل الصوتية ما أقدر أسمعها حالياً، بس لو حكيتلي نص أساعدك بثواني! 😊");
                await react('✅');
                return;
            }

            // ===== الرسائل النصية =====
            if (!safeBody) return;

            // فحص إذا المستخدم سأل عن اسمه
            const askingAboutName = /اسم[يك]|من أنت|من انت|who are you|your name/i.test(safeBody);

            if (!userChats[sender]) userChats[sender] = [];

            // إضافة الاسم للسياق لو ما كان موجود
            if (userName && userChats[sender].length === 0) {
                userChats[sender].push({
                    role: 'user',
                    content: `[اسم المستخدم: ${userName}]`
                });
                userChats[sender].push({
                    role: 'assistant',
                    content: `أهلاً ${userName}!`
                });
            }

            userChats[sender].push({
                role: 'user',
                content: safeBody
            });
            stats.totalMessages++;

            // الحفاظ على آخر 20 رسالة فقط
            if (userChats[sender].length > 25)
                userChats[sender] = userChats[sender].slice(-25);

            const res = await askAI([
                { role: 'system', content: SYSTEM_PROMPT },
                ...userChats[sender]
            ]);

            userChats[sender].push({
                role: 'assistant',
                content: res
            });

            // إضافة رسالة المشاركة بشكل عشوائي (1 من كل 10 رسائل)
            const shouldAddShare = Math.random() < 0.1;
            const finalRes = shouldAddShare
                ? `${res}\n\n---\n_إذا عجبك البوت، شاركه مع أصحابك عشان يستفيدوا هم كمان_ 😊`
                : res;

            await reply(finalRes);
            await react('✅');

        } catch (error) {
            console.log('❌ خطأ عام:', error.message);
            try {
                await sock.sendMessage(msg.key.remoteJid, {
                    text: 'صار خطأ تقني، جرب مرة ثانية 🔧'
                }, { quoted: msg });
            } catch {}
        }
    });
}



// ===== START =====
console.log('🚀 جاري تشغيل البوت...');
startBot();
