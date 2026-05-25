const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const readline = require('readline');

const TOGETHER_API_KEY = 'tgp_v1_XkEPaONsD6nAUyqvGqQsq0-W3eH8uueeF7bWJOF8mUw';

const ADMIN_NUMBER = '972593850520';
const DAILY_LIMIT = 50;
let vipNumbers = [];
let userMessages = {};
let userChats = {};
let sock = null;

setInterval(() => { userMessages = {}; }, 24 * 60 * 60 * 1000);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

const SYSTEM_PROMPT = `أنت مساعد ذكي واسمك "بوت". تتحدث بالعربية العامية الفلسطينية أو الإنجليزية فقط.
- تحكي مثل صديق قريب: شو، كيفك، والله، يعني، بدي، هيك
- تتفاعل كأنك إنسان مش روبوت
- تتذكر المحادثة وتربط الأسئلة ببعض
- في الطب والتمريض: معلومات دقيقة ومفصلة جداً خطوة بخطوة
- إجابات واضحة وعملية`;

async function askAI(messages) {
    const response = await fetch('https://api.together.xyz/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${TOGETHER_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
            messages,
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
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '');
        const body = msg.message.conversation || (msg.message.extendedTextMessage || {}).text || '';
        if (!body) return;

        const isAdmin = sender === ADMIN_NUMBER;
        const isVip = vipNumbers.includes(sender);
        console.log('رسالة من:', sender, 'النص:', body);

        const reply = async (text) => {
            try {
                await sock.sendMessage(msg.key.remoteJid, { text });
            } catch (e) {
                console.log('خطا في الرد:', e.message);
            }
        };

        const react = async (emoji) => {
            try {
                await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } });
            } catch (e) {}
        };

        if (isAdmin) {
            if (body.startsWith('!vip ')) {
                const num = body.split(' ')[1];
                if (!vipNumbers.includes(num)) { vipNumbers.push(num); await reply('تم اضافة ' + num + ' كـ VIP'); }
                else await reply('الرقم موجود اصلا');
                return;
            }
            if (body.startsWith('!دل ')) {
                const num = body.split(' ')[1];
                vipNumbers = vipNumbers.filter(n => n !== num);
                await reply('تم حذف ' + num);
                return;
            }
            if (body === '!قائمة') { await reply(vipNumbers.length === 0 ? 'لا يوجد VIP' : vipNumbers.join('\n')); return; }
            if (body === '!احصائيات') { await reply(Object.entries(userMessages).map(([n,c]) => n+': '+c+' رسالة').join('\n') || 'لا يوجد'); return; }
            if (body === '!مساعدة') { await reply('!vip [رقم]\n!دل [رقم]\n!قائمة\n!احصائيات\n!مسح [رقم]'); return; }
            if (body.startsWith('!مسح ')) {
                const num = body.split(' ')[1];
                delete userChats[num];
                await reply('تم مسح جلسة ' + num);
                return;
            }
        }

        if (!isAdmin && !isVip) {
            if (!userMessages[sender]) userMessages[sender] = 0;
            if (userMessages[sender] >= DAILY_LIMIT) {
                await reply('وصلت للحد اليومي يا صديقي، ارجع بكرة!');
                return;
            }
            userMessages[sender]++;
        }

        if (!userChats[sender]) userChats[sender] = [];
        userChats[sender].push({ role: 'user', content: body });
        if (userChats[sender].length > 20) userChats[sender] = userChats[sender].slice(-20);

        try {
            await react('👍');
            const responseText = await askAI([
                { role: 'system', content: SYSTEM_PROMPT },
                ...userChats[sender]
            ]);
            userChats[sender].push({ role: 'assistant', content: responseText });
            await reply(responseText);
            await react('✅');
        } catch (error) {
            console.log('خطا:', error.message);
            await react('❌');
            await reply('صار خطأ، جرب مرة ثانية!');
        }
    });
}

startBot();
