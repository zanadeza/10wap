const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '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' });

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

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('امسح هذا الكود بواتساب');
});

client.on('ready', () => {
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

client.initialize();
