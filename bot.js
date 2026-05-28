const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const readline = require('readline');
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
    return { userNames: {}, welcomedUsers: {}, vipNumbers: [] };
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            userNames,
            welcomedUsers,
            vipNumbers
        }, null, 2));
    } catch (e) {
        console.log('خطأ في حفظ البيانات:', e.message);
    }
}

let { userNames, welcomedUsers, vipNumbers } = loadData();
let userChats = {};
let sock = null;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

// ===== SYSTEM PROMPT =====
const SYSTEM_PROMPT = `اسمك "نادر"، مساعد ذكي على واتساب.

أسلوبك:
- تحكي بالعامية العربية بشكل طبيعي ومريح
- تمزح وتضحك مع الناس بس بنفس الوقت بتعطي معلومات دقيقة وصح
- ردودك مفيدة ومباشرة، ما تحشو الكلام
- لو حدا حكيلك بالإنجليزي رد عليه بالإنجليزي
- لو سألك عن اسمك قلو: "أنا نادر 😄" بس ما تضل تكرر معلومات عن نفسك كل مرة
- كن ودود وطبيعي زي الصاحب

في المجال الطبي والعلمي:
- معلومات دقيقة وموثوقة
- اذكر الجرعات والأدوية بدقة لما يلزم
- نصح بمراجعة الطبيب للحالات المهمة

في باقي المجالات:
- إجابات علمية ودقيقة
- أمثلة عملية عند الحاجة
- لو ما بتعرف شي قول ما بعرف بدل ما تكذب

تذكر: اسم المستخدم اللي عم تحكي معو موجود في سياق المحادثة، استخدمو أحياناً بشكل طبيعي.`;

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

async function askAIWithImage(base64Image, userQuestion, userName) {
    try {
        const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'pixtral-large-latest',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'image_url',
                                image_url: { url: `data:image/jpeg;base64,${base64Image}` }
                            },
                            {
                                type: 'text',
                                text: userQuestion || 'احكيلي شو في هالصورة بالتفصيل'
                            }
                        ]
                    }
                ],
                max_tokens: 1500,
                temperature: 0.7
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

أنا *نادر*، مساعدك الذكي على واتساب! 🤖✨

قادر أساعدك في:
• أي سؤال أو استفسار 💬
• تحليل الصور 🖼️
• قراءة وشرح الملفات 📄
• معلومات طبية وعلمية 🏥
• والكثير غيرها...

بس خليك عارف إني شغال من *7 الصبح لـ 7 المسا* كل يوم ⏰

اسأل بدون تردد، أنا هون! 😄

---
_إذا عجبك البوت، شاركه مع أصحابك عشان يستفيدوا هم كمان_ 🙌`;
}

// ===== MAIN BOT =====
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['نادر Bot', 'Chrome', '1.0.0']
    });

    if (!state.creds.registered) {
        const number = await question('اكتب رقمك (مع كود البلد بدون +): ');
        const code = await sock.requestPairingCode(number.trim());
        console.log('\n🔑 كود الربط: ' + code + '\n');
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log('الاتصال انقطع، الكود:', code);
            if (shouldReconnect) {
                console.log('إعادة الاتصال خلال 5 ثواني...');
                setTimeout(startBot, 5000);
            } else {
                console.log('تم تسجيل الخروج، يجب ربط الجلسة من جديد.');
            }
        } else if (connection === 'open') {
            console.log('✅ البوت جاهز وشغال!');
        } else if (connection === 'connecting') {
            console.log('⏳ جاري الاتصال...');
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
                        `📊 إحصائيات البوت:\n` +
                        `• مستخدمين تم استقبالهم: ${welcomedCount}\n` +
                        `• مستخدمين نشطين في الجلسة: ${activeUsers}\n` +
                        `• أرقام VIP: ${vipNumbers.length}`
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
                        `!مسح [رقم] - مسح محادثة\n` +
                        `!مسح_كل - مسح كل الجلسات`
                    );
                    return;
                }
            }

            await react('👍');

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
startBot().catch(e => {
    console.error('خطأ في تشغيل البوت:', e);
    setTimeout(startBot, 5000);
});
