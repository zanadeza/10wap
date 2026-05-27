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

/* =========================
   FIX: fetch (Render fix)
========================= */
const fetch = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));

/* =========================
   AI CONFIG (Mistral)
========================= */
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || 'fZ0TSrAOJK3cBjkmj461Msqhk90d0HiL';

/* =========================
   ADMIN SETTINGS
========================= */
const ADMIN_NUMBER = '972593850520';
const DAILY_LIMIT = 50;

/* =========================
   MEMORY STORAGE
========================= */
let vipNumbers = [];
let userMessages = {};
let userChats = {};
let knownUsers = {};
let sock = null;
let db = null;

/* =========================
   AUTO CLEAN MEMORY
========================= */
setInterval(() => {
    userMessages = {};
}, 24 * 60 * 60 * 1000);

/* prevent memory overflow */
setInterval(() => {
    for (let key in userChats) {
        if (userChats[key]?.length > 30) {
            userChats[key] = userChats[key].slice(-20);
        }
    }
}, 60000);

/* =========================
   SAFE ERROR HANDLERS
========================= */
process.on('uncaughtException', (err) => {
    console.log('UNCAUGHT ERROR:', err);
});

process.on('unhandledRejection', (err) => {
    console.log('PROMISE ERROR:', err);
});

/* =========================
   CLI INPUT
========================= */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

/* =========================
   SYSTEM PROMPT
========================= */
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

/* =========================
   AI TEXT (MISTRAL)
========================= */
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
                max_tokens: 1000
            })
        });

        const data = await response.json();

        if (!data?.choices?.[0]) {
            console.log("AI fallback triggered");
            return "النظام مشغول حالياً، حاول لاحقاً.";
        }

        return data.choices[0].message.content;

    } catch (e) {
        console.log("AI ERROR:", e.message);
        return "حدث خطأ في الذكاء الاصطناعي، يرجى المحاولة مرة أخرى.";
    }
}

/* =========================
   AI IMAGE
========================= */
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

        if (!data?.choices?.[0]) {
            return "حدث خطأ في تحليل الصورة.";
        }

        return data.choices[0].message.content;

    } catch (e) {
        console.log("AI IMAGE ERROR:", e.message);
        return "حدث خطأ في تحليل الصورة.";
    }
}

/* =========================
   FIREBASE
========================= */
async function saveToFirebase(key, value) {
    try {
        await db.collection('bot_data').doc(key).set({
            value,
            updatedAt: new Date()
        });
    } catch (e) {
        console.log('Firebase error:', e.message);
    }
}

async function loadFromFirebase(key) {
    try {
        const doc = await db.collection('bot_data').doc(key).get();
        return doc.exists ? doc.data().value : null;
    } catch (e) {
        console.log('Firebase load error:', e.message);
        return null;
    }
}

/* =========================
   BOT START
========================= */
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

            console.log("Disconnected:", code);

            if (code !== DisconnectReason.loggedOut) {
                setTimeout(() => {
                    console.log("Reconnecting...");
                    startBot();
                }, 5000);
            } else {
                console.log("Logged out - QR required");
            }
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
            const msgType = Object.keys(message).find(k => message[k]);

            if (!msgType) return;

            const jid = msg.key?.remoteJid;
            if (!jid) return;

            const isGroup = jid.endsWith('@g.us');
            const sender = msg.key?.participant || jid;
            const senderNumber = sender.replace('@s.whatsapp.net', '').replace('@lid', '');

            const body =
                message?.conversation ||
                message?.extendedTextMessage?.text ||
                message?.imageMessage?.caption ||
                message?.documentMessage?.caption ||
                '';

            const safeBody = body || '';

            const isAdmin = senderNumber === ADMIN_NUMBER;
            const isVip = vipNumbers.includes(senderNumber);

            const reply = async (text) => {
                try {
                    await sock.sendMessage(jid, { text });
                } catch (e) {
                    console.log('Reply error:', e.message);
                }
            };

            const react = async (emoji) => {
                try {
                    await sock.sendMessage(jid, {
                        react: { text: emoji, key: msg.key }
                    });
                } catch {}
            };

            if (!isGroup && !knownUsers[senderNumber]) {
                knownUsers[senderNumber] = true;
                await reply(`مرحباً 👋\nأنا MEDTERM`);
            }

            /* ================= ADMIN COMMANDS ================= */
            if (isAdmin) {
                if (safeBody.startsWith('!vip ')) {
                    const num = safeBody.split(' ')[1];
                    if (!vipNumbers.includes(num)) vipNumbers.push(num);
                    await reply('VIP added');
                    return;
                }

                if (safeBody.startsWith('!دل ')) {
                    const num = safeBody.split(' ')[1];
                    vipNumbers = vipNumbers.filter(n => n !== num);
                    await reply('VIP removed');
                    return;
                }

                if (safeBody === '!قائمة') {
                    await reply(vipNumbers.join('\n') || 'فارغة');
                    return;
                }
            }

            /* ================= LIMIT ================= */
            if (!isAdmin && !isVip) {
                if (!userMessages[senderNumber]) userMessages[senderNumber] = 0;
                if (userMessages[senderNumber] >= DAILY_LIMIT) {
                    await reply('تم تجاوز الحد اليومي');
                    return;
                }
                userMessages[senderNumber]++;
            }

            await react('👍');

            /* ================= IMAGE ================= */
            if (msgType === 'imageMessage') {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
                const base64 = buffer.toString('base64');
                const res = await askAIWithImage(base64, safeBody);
                await reply(res);
                await react('✅');
                return;
            }

            /* ================= CHAT ================= */
            if (!userChats[senderNumber]) userChats[senderNumber] = [];

            userChats[senderNumber].push({ role: 'user', content: safeBody });

            const res = await askAI([
                { role: 'system', content: SYSTEM_PROMPT },
                ...userChats[senderNumber]
            ]);

            userChats[senderNumber].push({ role: 'assistant', content: res });

            await reply(res);
            await react('✅');

        } catch (err) {
            console.log('ERROR:', err.message);
            await react('❌');
        }
    });
}

/* =========================
   MAIN
========================= */
async function main() {
    try {
        const serviceAccount = {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        };

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        db = admin.firestore();
        console.log('Firebase connected');

    } catch (e) {
        console.log('Firebase error:', e.message);
    }

    await startBot();
}

main();
