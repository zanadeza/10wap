const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const readline = require('readline');
const admin = require('firebase-admin');
const fs = require('fs');

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || 'fZ0TSrAOJK3cBjkmj461Msqhk90d0HiL';
const ADMIN_NUMBER = '972593850520';
const DAILY_LIMIT = 50;

let vipNumbers = [];
let userMessages = {};
let userChats = {};
let knownUsers = {};
let sock = null;
let db = null;

setInterval(() => { userMessages = {}; }, 24 * 60 * 60 * 1000);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

const SYSTEM_PROMPT = `أنت بوت ذكاء اصطناعي اسمك "MEDTERM"، قام ببرمجتك المهندس نادر.

أسلوبك:
- تتكلم بشكل رسمي وجدي
- ردودك دقيقة ومختصرة ومفيدة
- لا تستخدم كلام فارغ أو مقدمات غير ضرورية
- تتكلم العربية الفصحى أو الإنجليزية فقط
- لا تستخدم العامية أو الكلام غير الرسمي

في المجال الطبي والتمريضي:
- معلومات دقيقة ومفصلة وموثوقة
- تشرح الأعراض والأسباب والعلاج خطوة بخطوة
- تذكر الجرعات والأدوية بدقة
- تنصح بمراجعة الطبيب عند الضرورة
- تستخدم المصطلحات الطبية الصحيحة

في باقي المجالات:
- إجابات علمية ودقيقة
- أمثلة عملية عند الحاجة
- لا تتكلم بما لا تعرفه

إذا سألك أحد عن اسمك: "أنا MEDTERM، بوت ذكاء اصطناعي متخصص، قام ببرمجتي المهندس نادر."
إذا سألك عن مطورك: "قام ببرمجتي المهندس نادر."`;

async function askAI(messages) {
    try {
        const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ model: 'mistral-small-latest', messages, max_tokens: 1000 })
        });
        const data = await response.json();
        if (!data?.choices?.[0]) throw new Error('AI error');
        return data.choices[0].message.content;
    } catch (e) {
        console.log("AI ERROR:", e.message);
        return "حدث خطأ في الذكاء الاصطناعي، يرجى المحاولة مرة أخرى.";
    }
}

async function askAIWithImage(base64Image, question) {
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
                            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
                            { type: 'text', text: question || 'اشرح هذه الصورة بالتفصيل' }
                        ]
                    }
                ],
                max_tokens: 1000
            })
        });
        const data = await response.json();
        if (!data?.choices?.[0]) throw new Error('AI image error');
        return data.choices[0].message.content;
    } catch (e) {
        console.log("AI IMAGE ERROR:", e.message);
        return "حدث خطأ في تحليل الصورة.";
    }
}

async function saveToFirebase(key, value) {
    try {
        await db.collection('bot_data').doc(key).set({ value, updatedAt: new Date() });
    } catch (e) {
        console.log('خطأ في Firebase:', e.message);
    }
}

async function loadFromFirebase(key) {
    try {
        const doc = await db.collection('bot_data').doc(key).get();
        return doc.exists ? doc.data().value : null;
    } catch (e) {
        console.log('خطأ في تحميل Firebase:', e.message);
        return null;
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    sock = makeWASocket({ auth: state });

    if (!state.creds.registered) {
        const number = await question('اكتب رقمك: ');
        const code = await sock.requestPairingCode(number.trim());
        console.log('كود الربط: ' + code);
    }

    sock.ev.on('creds.update', async () => {
        await saveCreds();
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(startBot, 3000);
        } else if (connection === 'open') {
            console.log('البوت جاهز!');
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
                for (let k of keys) {
                    if (message[k] !== undefined && message[k] !== null) return k;
                }
                return null;
            })();

            if (!msgType) return;
            if (['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'].includes(msgType)) return;

            const jid = msg.key?.remoteJid;
            if (!jid) return;

            const isGroup = jid.endsWith('@g.us');
            const sender = msg.key?.participant || jid;
            const senderNumber = sender.replace('@s.whatsapp.net', '').replace('@lid', '');

            const body =
                (typeof message?.conversation === 'string' && message.conversation) ||
                (typeof message?.extendedTextMessage?.text === 'string' && message.extendedTextMessage.text) ||
                (typeof message?.imageMessage?.caption === 'string' && message.imageMessage.caption) ||
                (typeof message?.documentMessage?.caption === 'string' && message.documentMessage.caption) ||
                '';

            const safeBody = body || '';

            if (isGroup) {
                if (!safeBody.toLowerCase().startsWith('نادر')) return;
            }

            const isAdmin = senderNumber === ADMIN_NUMBER;
            const isVip = vipNumbers.includes(senderNumber);

            console.log('رسالة من:', senderNumber, 'النوع:', msgType, 'مجموعة:', isGroup);

            const reply = async (text) => {
                try { await sock.sendMessage(jid, { text }); } catch (e) { console.log('خطا في الرد:', e.message); }
            };

            const react = async (emoji) => {
                try { await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }); } catch {}
            };

            if (!isGroup && !knownUsers[senderNumber]) {
                knownUsers[senderNumber] = true;
                const pushName = msg.pushName || 'عزيزي';
                await reply(`مرحباً ${pushName}! 👋\nأنا MEDTERM، بوت ذكاء اصطناعي متخصص.\nقام ببرمجتي المهندس نادر.\n\nكيف يمكنني مساعدتك؟`);
            }

            if (isAdmin) {
                if (safeBody.startsWith('!vip ')) {
                    const num = safeBody.split(' ')[1];
                    if (!vipNumbers.includes(num)) vipNumbers.push(num);
                    await reply('تم إضافة ' + num + ' كـ VIP');
                    return;
                }
                if (safeBody.startsWith('!دل ')) {
                    const num = safeBody.split(' ')[1];
                    vipNumbers = vipNumbers.filter(n => n !== num);
                    await reply('تم حذف ' + num + ' من VIP');
                    return;
                }
                if (safeBody === '!قائمة') { await reply(vipNumbers.length ? vipNumbers.join('\n') : 'لا يوجد أرقام VIP'); return; }
                if (safeBody === '!احصائيات') { await reply(Object.entries(userMessages).map(([n, c]) => `${n}: ${c} رسالة`).join('\n') || 'لا يوجد إحصائيات'); return; }
                if (safeBody === '!مساعدة') { await reply('أوامر لوحة التحكم:\n!vip [رقم]\n!دل [رقم]\n!قائمة\n!احصائيات\n!مسح [رقم]'); return; }
                if (safeBody.startsWith('!مسح ')) {
                    const num = safeBody.split(' ')[1];
                    delete userChats[num];
                    await reply('تم مسح جلسة ' + num);
                    return;
                }
            }

            if (!isAdmin && !isVip) {
                if (!userMessages[senderNumber]) userMessages[senderNumber] = 0;
                if (userMessages[senderNumber] >= DAILY_LIMIT) {
                    await reply('لقد وصلت إلى الحد اليومي المسموح به. يرجى المحاولة غداً.');
                    return;
                }
                userMessages[senderNumber]++;
            }

            await react('👍');

            if (msgType === 'audioMessage') {
                await reply('عذراً، لا يمكنني معالجة الرسائل الصوتية حالياً. يرجى إرسال رسالة نصية.');
                await react('❌');
                return;
            }

            if (msgType === 'imageMessage') {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
                const base64 = buffer.toString('base64');
                const res = await askAIWithImage(base64, safeBody);
                await reply(res);
                await react('✅');
                return;
            }

            if (msgType === 'documentMessage') {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
                const text = buffer.toString('utf-8');
                const q = safeBody || 'اشرح هذا الملف بالتفصيل';
                if (!userChats[senderNumber]) userChats[senderNumber] = [];
                userChats[senderNumber].push({ role: 'user', content: `${q}\n\n${text.slice(0, 5000)}` });
                const res = await askAI([{ role: 'system', content: SYSTEM_PROMPT }, ...userChats[senderNumber]]);
                userChats[senderNumber].push({ role: 'assistant', content: res });
                await reply(res);
                await react('✅');
                return;
            }

            if (!safeBody) return;
            if (!userChats[senderNumber]) userChats[senderNumber] = [];

            const cleanBody = isGroup ? safeBody.replace(/^نادر\s*/i, '').trim() : safeBody;

            userChats[senderNumber].push({ role: 'user', content: cleanBody });
            if (userChats[senderNumber].length > 20) userChats[senderNumber] = userChats[senderNumber].slice(-20);
            const res = await askAI([{ role: 'system', content: SYSTEM_PROMPT }, ...userChats[senderNumber]]);
            userChats[senderNumber].push({ role: 'assistant', content: res });
            await reply(res);
            await react('✅');

        } catch (error) {
            console.log('خطا:', error.message);
            await react('❌');
        }
    });
}

async function main() {
    try {
        const serviceAccount = require('./firebase.json');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        console.log('تم الاتصال بـ Firebase');
    } catch (e) {
        console.log('خطأ في Firebase:', e.message);
    }
    await startBot();
}

main();
