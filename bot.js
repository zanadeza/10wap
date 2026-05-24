const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Groq = require('groq-sdk');
const express = require('express');
const qrcode = require('qrcode');

const app = express();
const PORT = 3000;

const groq = new Groq({ apiKey: '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' });
const ADMIN_NUMBER = '972593850520';
const DAILY_LIMIT = 50;
let vipNumbers = [];
let userMessages = {};
let lastQR = null;

setInterval(() => { userMessages = {}; }, 24 * 60 * 60 * 1000);

app.get('/', async (req, res) => {
    if (lastQR) {
        const img = await qrcode.toDataURL(lastQR);
        res.send('<html><body style="text-align:center"><h2>امسح الكود</h2><img src="' + img + '" style="width:300px"/><script>setTimeout(()=>location.reload(),5000)</script></body></html>');
    } else {
        res.send('<h2 style="text-align:center;margin-top:100px">البوت جاهز!</h2>');
    }
});

app.listen(PORT, () => console.log('افتح المتصفح على http://localhost:3000'));

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({ auth: state });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            lastQR = qr;
            console.log('افتح المتصفح على http://localhost:3000');
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            lastQR = null;
            console.log('البوت جاهز!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const sender = msg.key.remoteJid.replace('@s.whatsapp.net', '');
        const body = msg.message.conversation || (msg.message.extendedTextMessage || {}).text || '';
        const isAdmin = sender === ADMIN_NUMBER;
        const isVip = vipNumbers.includes(sender);
        console.log('رسالة من:', sender, 'النص:', body);
        const reply = (text) => sock.sendMessage(msg.key.remoteJid, { text });
        if (isAdmin) {
            if (body.startsWith('!vip ')) {
                const num = body.split(' ')[1];
                if (!vipNumbers.includes(num)) { vipNumbers.push(num); reply('تم اضافة ' + num + ' كـ VIP'); }
                else reply('الرقم موجود اصلا');
                return;
            }
            if (body.startsWith('!دل ')) {
                const num = body.split(' ')[1];
                vipNumbers = vipNumbers.filter(n => n !== num);
                reply('تم حذف ' + num);
                return;
            }
            if (body === '!قائمة') { reply(vipNumbers.length === 0 ? 'لا يوجد VIP' : vipNumbers.join('\n')); return; }
            if (body === '!احصائيات') { reply(Object.entries(userMessages).map(([n,c]) => n+': '+c+' رسالة').join('\n') || 'لا يوجد'); return; }
            if (body === '!مساعدة') { reply('!vip [رقم]\n!دل [رقم]\n!قائمة\n!احصائيات'); return; }
        }
        if (!isAdmin && !isVip) {
            if (!userMessages[sender]) userMessages[sender] = 0;
            if (userMessages[sender] >= DAILY_LIMIT) { reply('وصلت للحد اليومي. عد غدا!'); return; }
            userMessages[sender]++;
        }
        try {
            const response = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: 'انت مساعد ذكي رد بالعربية' },
                    { role: 'user', content: body }
                ]
            });
            reply(response.choices[0].message.content);
        } catch (error) {
            console.log(error);
            reply('حدث خطا');
        }
    });
}

startBot();
