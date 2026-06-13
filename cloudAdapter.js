'use strict';

// ============================================================
// cloudAdapter.js
// يحوّل رسالة واردة من WhatsApp Cloud API Webhook
// إلى نفس الشكل (shape) الذي كان ينتجه Baileys في messages.upsert
// حتى يبقى كل منطق المعالجة في bot_full.js يعمل بدون أي تعديل إضافي
// ============================================================

/**
 * msg: عنصر واحد من value.messages[] في الـ webhook payload
 * value: قيمة change.value الكاملة (تحتوي contacts, metadata...)
 * returns: كائن بصيغة Baileys-like { key, message, messageTimestamp, pushName }
 */
function adaptCloudMessage(msg, value) {
    const from = msg.from; // رقم المرسل (بدون +)
    const msgId = msg.id;
    const type = msg.type;
    const pushName = value?.contacts?.[0]?.profile?.name || '';

    const key = {
        remoteJid: from,       // في Cloud API: نفس رقم المرسل (لا يوجد @s.whatsapp.net حقيقي، لكن endsWith('@g.us') = false دائماً وهذا صحيح لأن لا مجموعات)
        participant: from,
        id: msgId,
        fromMe: false
    };

    const messageTimestamp = msg.timestamp ? parseInt(msg.timestamp, 10) : Math.floor(Date.now() / 1000);

    let message = {};

    switch (type) {
        case 'text':
            message = { conversation: msg.text?.body || '' };
            break;

        case 'image':
            message = {
                imageMessage: {
                    id: msg.image?.id,
                    mimetype: msg.image?.mime_type || 'image/jpeg',
                    caption: msg.image?.caption || '',
                    fileLength: 0 // Cloud API لا يرسل حجم الملف في الـ webhook — يُتحقق بعد التنزيل إن لزم
                }
            };
            break;

        case 'document':
            message = {
                documentMessage: {
                    id: msg.document?.id,
                    mimetype: msg.document?.mime_type || '',
                    fileName: msg.document?.filename || 'ملف',
                    caption: msg.document?.caption || '',
                    fileLength: 0
                }
            };
            break;

        case 'audio':
            message = {
                audioMessage: {
                    id: msg.audio?.id,
                    mimetype: msg.audio?.mime_type || 'audio/ogg; codecs=opus'
                }
            };
            break;

        case 'video':
            message = {
                videoMessage: {
                    id: msg.video?.id,
                    mimetype: msg.video?.mime_type || 'video/mp4',
                    caption: msg.video?.caption || ''
                }
            };
            break;

        default:
            // أنواع غير مدعومة (location, contacts, sticker, button, interactive...) — تُتجاهل
            message = {};
            break;
    }

    return {
        key,
        message,
        messageTimestamp,
        pushName
    };
}

module.exports = { adaptCloudMessage };
