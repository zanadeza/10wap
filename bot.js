console.log("🚀 BOT STARTING...");

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
   FETCH FIX (Render/Railway)
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
   MEMORY STORAGE (NO CHANGE)
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
   CLI INPUT (FIXED FOR RAILWAY)
   ❗ بدل readline التفاعلي نخليه optional
========================= */
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (text) => {
    return new Promise(resolve => {
        // Railway fix: لا يعلق إذا ما في input
        try {
            rl.question(text, answer => resolve(answer));
        } catch {
            resolve('');
        }
    });
};

/* =========================
   SYSTEM PROMPT (UNCHANGED STYLE)
========================= */
const SYSTEM_PROMPT = `أنت بوت ذكاء اصطناعي اسمك "MEDTERM"، قام ببرمجتك المهندس نادر.

أسلوبك:
- تتكلم بشكل رسمي وجدي
- ردودك دقيقة ومختصرة ومفيدة
- لا تستخدم كلام فارغ
- العربية الفصحى أو الإنجليزية

في الطب:
- شرح دقيق
- أعراض وأسباب وعلاج
- جرعات عند الحاجة
- تنصح بالطبيب

إذا سُئلت عنك:
"أنا MEDTERM، بوت ذكاء اصطناعي متخصص، قام ببرمجتي المهندس نادر."`;

/* =========================
   MISTRAL AI (UNCHANGED LOGIC)
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
            return "النظام مشغول حالياً";
        }

        return data.choices[0].message.content;

    } catch (e) {
        return "AI ERROR";
    }
}

/* =========================
   IMAGE AI (UNCHANGED LOGIC)
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
                            {
                                type: 'image_url',
                                image_url: { url: `data:image/jpeg;base64,${base64Image}` }
                            },
                            {
                                type: 'text',
                                text: question || 'اشرح الصورة'
                            }
                        ]
                    }
                ],
                max_tokens: 1000
            })
        });

        const data = await response.json();
        return data?.choices?.[0]?.message?.content || "IMAGE ERROR";

    } catch (e) {
        return "IMAGE ERROR";
    }
}

/* =========================
   FIREBASE (FIX ONLY)
========================= */
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
    console.log("🔥 Firebase connected");

} catch (e) {
    console.log("⚠️ Firebase error:", e.message);
}

/* =========================
   SAVE / LOAD FIREBASE (UNCHANGED)
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
        return null;
    }
}

/* =========================
   BOT START (FIX ONLY)
   ❗ حذفنا readline الإجباري + pairing problem
========================= */
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;

            console.log("Disconnected:", code);

            if (code !== DisconnectReason.loggedOut) {
                setTimeout(() => {
                    startBot();
                }, 7000);
            } else {
                console.log("Logged out → delete auth_info");
            }
        }

        if (connection === 'open') {
            console.log("WhatsApp Connected");
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;

            const msg = messages?.[0];
            if (!msg?.message || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;
            const sender = msg.key.participant || jid;
            const senderNumber = sender.replace('@s.whatsapp.net', '');

            const body =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.documentMessage?.caption ||
                '';

            const reply = (t) => sock.sendMessage(jid, { text: t });

            const react = async (emoji) => {
                try {
                    await sock.sendMessage(jid, {
                        react: { text: emoji, key: msg.key }
                    });
                } catch {}
            };

            const isAdmin = senderNumber === ADMIN_NUMBER;
            const isVip = vipNumbers.includes(senderNumber);

            /* ================= ADMIN ================= */
            if (isAdmin) {
                if (body.startsWith('!vip ')) {
                    const num = body.split(' ')[1];
                    if (!vipNumbers.includes(num)) vipNumbers.push(num);
                    return reply('VIP added');
                }

                if (body.startsWith('!del ')) {
                    const num = body.split(' ')[1];
                    vipNumbers = vipNumbers.filter(n => n !== num);
                    return reply('VIP removed');
                }

                if (body === '!list') {
                    return reply(vipNumbers.join('\n') || 'empty');
                }
            }

            /* ================= LIMIT ================= */
            if (!isAdmin && !isVip) {
                if (!userMessages[senderNumber]) userMessages[senderNumber] = 0;

                if (userMessages[senderNumber] >= DAILY_LIMIT) {
                    return reply('LIMIT REACHED');
                }

                userMessages[senderNumber]++;
            }

            await react('👍');

            /* ================= IMAGE ================= */
            if (msg.message?.imageMessage) {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
                const base64 = buffer.toString('base64');

                const res = await askAIWithImage(base64, body);
                await reply(res);
                return react('✅');
            }

            /* ================= CHAT ================= */
            if (!userChats[senderNumber]) userChats[senderNumber] = [];

            userChats[senderNumber].push({ role: 'user', content: body });

            const res = await askAI([
                { role: 'system', content: SYSTEM_PROMPT },
                ...userChats[senderNumber]
            ]);

            userChats[senderNumber].push({ role: 'assistant', content: res });

            await reply(res);
            await react('✅');

        } catch (e) {
            console.log('ERROR:', e.message);
        }
    });
}
const fs = require('fs');

fs.rmSync('auth_info', { recursive: true, force: true });
startBot();
