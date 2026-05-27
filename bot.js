console.log("🚀 BOT STARTING...");

/* =========================
   IMPORTS
========================= */
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const admin = require('firebase-admin');
const fs = require('fs');

/* =========================
   FETCH FIX (Render)
========================= */
const fetch = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));

/* =========================
   ENV
========================= */
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || 'fZ0TSrAOJK3cBjkmj461Msqhk90d0HiL';
const ADMIN_NUMBER = '972593850520';
const DAILY_LIMIT = 50;

/* =========================
   MEMORY
========================= */
let vipNumbers = [];
let userMessages = {};
let userChats = {};
let knownUsers = {};
let sock;

/* =========================
   FIREBASE (SAFE INIT)
========================= */
let db = null;

try {
    const serviceAccount = {
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    };

    if (serviceAccount.project_id && serviceAccount.client_email && serviceAccount.private_key) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        db = admin.firestore();
        console.log("🔥 Firebase connected");
    } else {
        console.log("⚠️ Firebase skipped (missing env)");
    }
} catch (e) {
    console.log("⚠️ Firebase error:", e.message);
}

/* =========================
   CLEAN MEMORY
========================= */
setInterval(() => {
    userMessages = {};
}, 24 * 60 * 60 * 1000);

setInterval(() => {
    for (let k in userChats) {
        if (userChats[k]?.length > 25) {
            userChats[k] = userChats[k].slice(-15);
        }
    }
}, 60000);

/* =========================
   SYSTEM PROMPT
========================= */
const SYSTEM_PROMPT = `أنت بوت ذكاء اصطناعي اسمك "MEDTERM"، قام ببرمجتك المهندس نادر.

أسلوبك:
- رسمي ومختصر
- دقيق
- بدون حشو
- عربي فصحى أو إنجليزي فقط

في الطب:
- شرح علمي دقيق
- نصائح طبية صحيحة
- تنبيه لمراجعة الطبيب عند الحاجة
`;

/* =========================
   AI REQUEST
========================= */
async function askAI(messages) {
    try {
        const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'mistral-small-latest',
                messages,
                max_tokens: 800
            })
        });

        const data = await res.json();

        if (!data?.choices?.[0]) {
            return "النظام مشغول حالياً.";
        }

        return data.choices[0].message.content;

    } catch (e) {
        return "خطأ في الذكاء الاصطناعي.";
    }
}

/* =========================
   IMAGE AI
========================= */
async function askAIWithImage(base64Image, question) {
    try {
        const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
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
                                image_url: {
                                    url: `data:image/jpeg;base64,${base64Image}`
                                }
                            },
                            {
                                type: 'text',
                                text: question || 'اشرح الصورة'
                            }
                        ]
                    }
                ],
                max_tokens: 800
            })
        });

        const data = await res.json();

        return data?.choices?.[0]?.message?.content || "خطأ في تحليل الصورة";

    } catch {
        return "خطأ في الصورة";
    }
}

/* =========================
   BOT START
========================= */
async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');

        sock = makeWASocket({ auth: state });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'open') {
                console.log("✅ WhatsApp connected");
            }

            if (connection === 'close') {
                const code = lastDisconnect?.error?.output?.statusCode;

                console.log("❌ Disconnected:", code);

                if (code !== DisconnectReason.loggedOut) {
                    setTimeout(startBot, 3000);
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            const msg = messages?.[0];
            if (!msg?.message || msg?.key?.fromMe) return;

            const jid = msg.key.remoteJid;
            const sender = msg.key.participant || jid;
            const number = sender.split('@')[0];

            const body =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                '';

            if (!body) return;

            const isAdmin = number === ADMIN_NUMBER;
            const isVip = vipNumbers.includes(number);

            /* LIMIT */
            if (!isAdmin && !isVip) {
                if (!userMessages[number]) userMessages[number] = 0;
                if (userMessages[number] >= DAILY_LIMIT) return;
                userMessages[number]++;
            }

            /* MEMORY */
            if (!userChats[number]) userChats[number] = [];

            userChats[number].push({ role: 'user', content: body });

            const reply = await askAI([
                { role: 'system', content: SYSTEM_PROMPT },
                ...userChats[number]
            ]);

            userChats[number].push({ role: 'assistant', content: reply });

            await sock.sendMessage(jid, { text: reply });
        });

    } catch (e) {
        console.log("BOT ERROR:", e.message);
        setTimeout(startBot, 5000);
    }
}

/* =========================
   RUN
========================= */
startBot();
