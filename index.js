const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const Groq = require('groq-sdk');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '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' });

let qrImageUrl = null;
let botReady = false;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', async (qr) => {
    qrImageUrl = await qrcode.toDataURL(qr);
    console.log('QR Code جاهز — افتح الرابط لمسحه');
});

client.on('ready', () => {
    botReady = true;
    qrImageUrl = null;
    console.log('البوت جاهز!');
});

client.on('message', async (msg) => {
    try {
        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: 'أنت مساعد ذكي، رد دائماً بالعربية' },
                { role: 'user', content: msg.body }
            ]
        });
        msg.reply(response.choices[0].message.content);
    } catch (error) {
        console.log(error);
        msg.reply('حدث خطأ، حاول مرة ثانية');
    }
});

app.get('/', (req, res) => {
    if (botReady) {
        res.send('<h1 style="color:green;text-align:center;margin-top:100px">✅ البوت شغال!</h1>');
    } else if (qrImageUrl) {
        res.send(`
            <html>
            <body style="text-align:center;margin-top:50px">
                <h2>امسح الكود لتشغيل البوت</h2>
                <img src="${qrImageUrl}" style="width:300px;height:300px"/>
                <p>بعد المسح انتظر وحدث الصفحة</p>
            </body>
            </html>
        `);
    } else {
        res.send('<h2 style="text-align:center;margin-top:100px">⏳ جاري التحميل... حدث الصفحة بعد ثوانٍ</h2>');
    }
});

app.listen(PORT, () => {
    console.log(`السيرفر شغال على بورت ${PORT}`);
});

client.initialize();
