'use strict';

// ============================================================
// whatsappClient.js
// طبقة اتصال رسمية مع WhatsApp Cloud API (Graph API)
// تستبدل بالكامل sock.sendMessage / downloadMediaMessage من Baileys
// ============================================================

const GRAPH_VERSION = 'v21.0';

const TOKEN          = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

if (!TOKEN || !PHONE_NUMBER_ID) {
    console.error('❌ تأكد من تعيين WHATSAPP_TOKEN و PHONE_NUMBER_ID في ملف .env');
    process.exit(1);
}

const BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}`;

function authHeaders(extra = {}) {
    return {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...extra
    };
}

// ------------------------------------------------------------
// إرسال رسالة نصية
// to: رقم المستلم بصيغة دولية بدون + (مثال: 972591234567)
// ------------------------------------------------------------
async function sendText(to, text) {
    const res = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: text, preview_url: false }
        })
    });
    return handleResponse(res, 'sendText');
}

// ------------------------------------------------------------
// إرسال رد على رسالة معينة (quoted/reply)
// ------------------------------------------------------------
async function sendReply(to, text, quotedMessageId) {
    const res = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: text, preview_url: false },
            context: quotedMessageId ? { message_id: quotedMessageId } : undefined
        })
    });
    return handleResponse(res, 'sendReply');
}

// ------------------------------------------------------------
// إرسال رياكشن (إيموجي) على رسالة
// ------------------------------------------------------------
async function sendReaction(to, messageId, emoji) {
    const res = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'reaction',
            reaction: { message_id: messageId, emoji }
        })
    });
    return handleResponse(res, 'sendReaction', true); // silent
}

// ------------------------------------------------------------
// إرسال صورة (image)
// imageBuffer: Buffer للصورة | caption: نص اختياري
// ------------------------------------------------------------
async function sendImage(to, imageBuffer, caption = '') {
    // الخطوة 1: رفع الصورة للحصول على media_id
    const mediaId = await uploadMedia(imageBuffer, 'image/jpeg', 'image.jpg');

    // الخطوة 2: إرسال الصورة بالـ media_id
    const res = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'image',
            image: { id: mediaId, caption }
        })
    });
    return handleResponse(res, 'sendImage');
}


async function sendVoiceNote(to, audioBuffer) {
    const mediaId = await uploadMedia(audioBuffer, 'audio/ogg; codecs=opus', 'voice.ogg');
    const res = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'audio',
            audio: { id: mediaId }
        })
    });
    return handleResponse(res, 'sendVoiceNote');
}

// ------------------------------------------------------------
// رفع ملف إلى Cloud API (يُستخدم قبل إرسال صور/صوت/مستندات)
// يُعيد media_id
// ------------------------------------------------------------
async function uploadMedia(buffer, mime, filename = 'file') {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([buffer], { type: mime }), filename);

    const res = await fetch(`${BASE_URL}/media`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKEN}` },
        body: form
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`[uploadMedia] ${JSON.stringify(data)}`);
    return data.id;
}

// ------------------------------------------------------------
// تنزيل ملف وارد (صورة/صوت/مستند) عبر media_id من الـ webhook payload
// يُعيد { buffer, mimeType, fileSize }
// ------------------------------------------------------------
async function downloadMedia(mediaId) {
    if (!mediaId) throw new Error('mediaId مفقود');

    // الخطوة 1: جلب رابط التنزيل المؤقت
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
        headers: authHeaders()
    });
    const meta = await metaRes.json();
    if (!metaRes.ok) throw new Error(`[downloadMedia:meta] ${JSON.stringify(meta)}`);

    // الخطوة 2: تنزيل المحتوى الفعلي (يتطلب نفس الـ Authorization header)
    const fileRes = await fetch(meta.url, { headers: authHeaders() });
    if (!fileRes.ok) throw new Error(`[downloadMedia:file] HTTP ${fileRes.status}`);

    const arrayBuffer = await fileRes.arrayBuffer();
    return {
        buffer: Buffer.from(arrayBuffer),
        mimeType: meta.mime_type || '',
        fileSize: meta.file_size || 0
    };
}

// ------------------------------------------------------------
// تعليم رسالة كمقروءة
// ------------------------------------------------------------
async function markAsRead(messageId) {
    const res = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId
        })
    });
    return handleResponse(res, 'markAsRead', true); // silent
}

// ------------------------------------------------------------
// معالجة موحّدة للردود
// ------------------------------------------------------------
async function handleResponse(res, label, silent = false) {
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
        if (!silent) console.error(`[${label}] خطأ ${res.status}:`, JSON.stringify(data));
        throw new Error(`[${label}] HTTP ${res.status}`);
    }
    return data;
}

module.exports = {
    sendText,
    sendReply,
    sendReaction,
    sendImage,
    sendVoiceNote,
    uploadMedia,
    downloadMedia,
    markAsRead
};
