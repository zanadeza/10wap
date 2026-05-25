const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const readline = require('readline');
const axios = require('axios');

const MISTRAL_API_KEY = 'fZ0TSrAOJK3cBjkmj461Msqhk90d0HiL';

const ADMIN_NUMBER = '972593850520';
const DAILY_LIMIT = 50;

let vipNumbers = [];
let userMessages = {};
let userChats = {};
let sock = null;

setInterval(() => { userMessages = {}; }, 24 * 60 * 60 * 1000);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

const SYSTEM_PROMPT = `اسمك "نادر"، مساعد ذكي طورك المهندس نادر.

أسلوبك:
- تتكلم بشكل رسمي وجدي
- ردودك دقيقة ومختصرة ومفيدة
- لا تستخدم كلام فارغ أو مقدمات غير ضرورية
- تتكلم العربية الفصحى أو الإنجليزية فقط
- لا تستخدم العامية أو الكلام غير الرسمي

في المجال الطبي والتمريضي:
- معلومات دقيقة ومفصلة وموثوقة
- تذكر الجرعات والأدوية بدقة
- تنصح بمراجعة الطبيب عند الضرورة
- تستخدم المصطلحات الطبية الصحيحة

في باقي المجالات:
- إجابات علمية ودقيقة
- أمثلة عملية عند الحاجة
- لا تتكلم بما لا تعرفه

إذا سألك أحد عن اسمك: "أنا نادر، مساعد ذكي طوره المهندس نادر"
إذا سألك عن مطورك: "طورني المهندس نادر"`;

async function askAI(messages) {
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
    if (data.error) throw new Error(data.error.message);
    return data.choices[0].message.content;
}

async function askAIWithImage(base64Image, question) {
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
    if (data.error) throw new Error(data.error.message);
    return data.choices[0].message.content;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    sock = makeWASocket({ auth: state });

    if (!state.creds.registered) {
        const number = await question('اكتب رقمك: ');
        const code = await sock.requestPairingCode(number.trim());
        console.log('كود الربط: ' + code);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => startBot(), 3000);
        } else if (connection === 'open') {
            console.log('البوت جاهز!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages?.[0];
        if (!msg?.message || msg?.key?.fromMe) return;

        const message = msg.message || {};

        // 🔥 FIX الأساسي (حل مشكلة reading '0')
        const msgType = Object.entries(message || {}).find(([k, v]) => v != null)?.[0];

        if (!msgType) return;

        if (
            msgType === 'protocolMessage' ||
            msgType === 'senderKeyDistributionMessage' ||
            msgType === 'messageContextInfo'
        ) return;

        const jid = msg.key?.remoteJid;
        if (!jid) return;

        const sender = jid
            .replace('@s.whatsapp.net', '')
            .replace('@lid', '')
            .replace('@g.us', '');

        // 🔥 FIX النهائي للـ body
        const body =
            typeof message?.conversation === 'string' ? message.conversation :
            typeof message?.extendedTextMessage?.text === 'string' ? message.extendedTextMessage.text :
            typeof message?.imageMessage?.caption === 'string' ? message.imageMessage.caption :
            typeof message?.documentMessage?.caption === 'string' ? message.documentMessage.caption :
            typeof message?.videoMessage?.caption === 'string' ? message.videoMessage.caption :
            '';

        const safeBody = body || '';

        const isAdmin = sender === ADMIN_NUMBER;
        const isVip = vipNumbers.includes(sender);

        console.log('رسالة من:', sender, 'النوع:', msgType);

        const reply = async (text) => {
            try {
                await sock.sendMessage(jid, { text });
            } catch (e) {
                console.log('خطا في الرد:', e.message);
            }
        };

        const react = async (emoji) => {
            try {
                await sock.sendMessage(jid, {
                    react: { text: emoji, key: msg.key }
                });
            } catch {}
        };

        // ===== ADMIN =====
        if (isAdmin) {
            if (safeBody.startsWith('!vip ')) {
                const num = safeBody.split(' ')[1];
                if (!vipNumbers.includes(num)) vipNumbers.push(num);
                await reply('تم إضافة VIP');
                return;
            }

            if (safeBody.startsWith('!دل ')) {
                vipNumbers = vipNumbers.filter(n => n !== safeBody.split(' ')[1]);
                await reply('تم الحذف');
                return;
            }

            if (safeBody === '!قائمة') {
                await reply(vipNumbers.length ? vipNumbers.join('\n') : 'لا يوجد VIP');
                return;
            }

            if (safeBody === '!احصائيات') {
                await reply(
                    Object.entries(userMessages)
                        .map(([n, c]) => `${n}: ${c} رسالة`)
                        .join('\n') || 'لا يوجد إحصائيات'
                );
                return;
            }

            if (safeBody === '!مساعدة') {
                await reply('أوامر لوحة التحكم جاهزة');
                return;
            }

            if (safeBody.startsWith('!مسح ')) {
                const num = safeBody.split(' ')[1];
                delete userChats[num];
                await reply('تم المسح');
                return;
            }
        }

        // ===== LIMIT =====
        if (!isAdmin && !isVip) {
            if (!userMessages[sender]) userMessages[sender] = 0;
            if (userMessages[sender] >= DAILY_LIMIT) {
                await reply('انتهى الحد اليومي');
                return;
            }
            userMessages[sender]++;
        }

        try {
            await react('👍');

            // IMAGE
            if (msgType === 'imageMessage') {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: sock.logger });
                const base64 = buffer.toString('base64');
                const res = await askAIWithImage(base64, safeBody);
                await reply(res);
                await react('✅');
                return;
            }

            // DOCUMENT
            if (msgType === 'documentMessage') {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: sock.logger });
                const text = buffer.toString('utf-8');

                const q = safeBody || 'اشرح الملف';

                if (!userChats[sender]) userChats[sender] = [];

                userChats[sender].push({
                    role: 'user',
                    content: `${q}\n\n${text.slice(0, 5000)}`
                });

                const res = await askAI([
                    { role: 'system', content: SYSTEM_PROMPT },
                    ...userChats[sender]
                ]);

                userChats[sender].push({ role: 'assistant', content: res });

                await reply(res);
                await react('✅');
                return;
            }

            // TEXT
            if (!safeBody) return;

            if (!userChats[sender]) userChats[sender] = [];

            userChats[sender].push({ role: 'user', content: safeBody });

            if (userChats[sender].length > 20)
                userChats[sender] = userChats[sender].slice(-20);

            const res = await askAI([
                { role: 'system', content: SYSTEM_PROMPT },
                ...userChats[sender]
            ]);

            userChats[sender].push({ role: 'assistant', content: res });

            await reply(res);
            await react('✅');

        } catch (error) {
            console.log('خطا:', error.message);
            await reply('حدث خطأ، يرجى المحاولة مرة أخرى.');
            await react('❌');
        }
    });
}

startBot();
