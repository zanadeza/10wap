# MedTerm — WhatsApp Cloud API (رسمي بالكامل)

تم تحويل البوت بالكامل من Baileys (جلسة/QR غير رسمية) إلى **WhatsApp Cloud API الرسمي** عبر Webhook.
**كل الميزات الأصلية محفوظة بدون حذف**: الذكاء الاصطناعي (Mistral/Pixtral/Voxtral)، الكوتا اليومية، نظام VIP، القائمة السوداء، تحليل الصور والـ PDF (بالنص والصور معاً)، TTS والترجمة الصوتية، أوامر المستخدم (`!مساعدة`, `!مسح`, `!رصيد`, `!لغة`, `!ملخص`)، أوامر الأدمن عبر واتساب (`!addvip`, `!removevip`, `!resetlimit`)، البث الجماعي، ولوحة تحكم Admin كاملة (HTML/CSS/JS) بكل تبويباتها.

## الملفات

| الملف | الوصف |
|---|---|
| `bot.js` | الملف الرئيسي — يحتوي **كل** منطق البوت الأصلي + لوحة التحكم + Webhook |
| `whatsappClient.js` | طبقة اتصال Cloud API (الإرسال، الرياكشن، الصوت، تنزيل الميديا) |
| `cloudAdapter.js` | يحوّل رسائل Webhook إلى نفس الشكل الذي كان يولّده Baileys، حتى يعمل كل المنطق القديم بدون تغيير |
| `.env.example` | نموذج بيانات الاعتماد |
| `package.json` | التبعيات (express غير مطلوب — يستخدم `http` المدمج) |

## 1. التثبيت على Termux

```bash
pkg update && pkg upgrade -y
pkg install nodejs mupdf-tools ffmpeg -y
npm install
```

أنشئ `.env`:

```bash
cp .env.example .env
nano .env
```

املأ:
- `WHATSAPP_TOKEN` — Access Token من Meta for Developers -> تطبيقك -> WhatsApp -> API Setup
- `PHONE_NUMBER_ID` — يظهر أسفل رقم الواتساب في نفس الصفحة
- `VERIFY_TOKEN` — أي نص سري تختاره أنت (مثال: `medterm_secret_2026`)
- `MISTRAL_API_KEY` — مفتاح Mistral الخاص بك
- `ADMIN_NUMBER` — رقمك بصيغة دولية بدون + (مثال: `972593850520`)
- `PORT` — افتراضي `8080`

> ⚠️ التوكن المؤقت (من Developer Mode) صالح 24 ساعة فقط.
> للحصول على توكن دائم: Business Settings -> System Users -> أنشئ System User -> اربطه بالتطبيق -> أصدر Token بصلاحية `whatsapp_business_messaging` بدون تاريخ انتهاء.

## 2. تشغيل البوت

```bash
npm start
```

سيعمل السيرفر على `http://localhost:8080` ويشمل:
- لوحة التحكم: `http://localhost:8080/` (تسجيل الدخول بنفس بيانات الأدمن الموجودة في الكود: `1122134` / `1125567` — يمكنك تغييرها داخل `bot.js` في `DASHBOARD_USER`/`DASHBOARD_PASS`)
- Webhook: `http://localhost:8080/webhook`

## 3. تشغيل ngrok وربطه

### التثبيت على Termux

```bash
pkg install wget -y
wget https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-arm64.tgz
tar -xvzf ngrok-v3-stable-linux-arm64.tgz
mv ngrok $PREFIX/bin/
```

> تحقق من معالجك بـ `uname -m` واستخدم النسخة المناسبة من https://ngrok.com/download إن لم يكن arm64.

### ربط الحساب (مرة واحدة)

سجّل حساباً مجانياً على https://ngrok.com، ثم:

```bash
ngrok config add-authtoken YOUR_AUTHTOKEN
```

### التشغيل المتزامن (بوت + ngrok) عبر tmux

```bash
pkg install tmux -y
tmux new -s bot
# داخل الجلسة:
npm start
# Ctrl+B ثم % لتقسيم الشاشة، ثم في النافذة الجديدة:
ngrok http 8080
```

ستحصل على رابط مثل:
```
Forwarding   https://abcd-1234-xyz.ngrok-free.app -> http://localhost:8080
```

## 4. ضبط Webhook في لوحة Meta

1. https://developers.facebook.com/apps -> تطبيقك -> WhatsApp -> Configuration
2. **Callback URL**: `https://abcd-1234-xyz.ngrok-free.app/webhook`
3. **Verify Token**: نفس قيمة `VERIFY_TOKEN` في `.env`
4. اضغط **Verify and Save** — يجب أن يظهر في تيرمنال البوت: `✅ تم التحقق من Webhook بنجاح`
5. في **Webhook fields**: فعّل (Subscribe) حقل `messages`

## 5. ملاحظات تشغيل مهمة

### تغيّر رابط ngrok
رابط ngrok المجاني يتغيّر مع كل إعادة تشغيل — يجب تحديث Callback URL في لوحة Meta كل مرة. للحل الدائم: استخدم خطة ngrok مدفوعة (Reserved Domain) أو استضف على VPS بدومين ثابت.

### نافذة الـ 24 ساعة (مهم جداً)
في WhatsApp Cloud API، يمكن الرد بحرية على المستخدم **خلال 24 ساعة فقط** من آخر رسالة استلمتها منه. الميزات التالية تعتمد على إرسال رسائل دون أن يكون المستخدم قد كتب حديثاً، وقد تفشل بعد انتهاء النافذة:
- إشعارات انتهاء VIP التلقائية (`checkVIPExpiry`)
- البث الجماعي (`broadcastToAll` / `!بث` من اللوحة)
- إشعارات الأدمن (`notifyAdmin`)
- إشعارات تفعيل/تجديد/إزالة VIP من اللوحة

**الحل**: أنشئ **Message Templates** معتمدة من Meta (WhatsApp Manager -> Message Templates) لهذه الحالات، واستخدم endpoint مختلف (`type: "template"`) عند انتهاء النافذة. هذا غير مفعّل حالياً في الكود لأنه يتطلب موافقة Meta على نص القالب مسبقاً.

### حدود الوسائط
- الصور: حتى ~5MB (سياسة Meta الحالية)
- المستندات: حتى ~100MB
- الكود يفرض حدوده الخاصة فوق ذلك (8MB للصور، 1MB/20MB للـ PDF حسب VIP) — يتم فحصها **بعد** التنزيل لأن Cloud API لا يرسل حجم الملف في الـ webhook.

## 6. الميزات المنقولة بالكامل (مطابقة 100% للأصل)

- ✅ نظام الذكاء الاصطناعي الكامل (Mistral small/large + Pixtral + Voxtral)
- ✅ System Prompts الطبية والعامة، وكشف الاستعلامات الطبية لتفعيل TTS التلقائي
- ✅ الكوتا اليومية (رسائل/صور/صوت) + نظام VIP مع تاريخ انتهاء وتجديد تلقائي
- ✅ القائمة السوداء (Blacklist) مع إشعار دوري
- ✅ تحليل الصور (مع/بدون سؤال) عبر Pixtral
- ✅ تحليل ملفات PDF (نص + صور الصفحات عبر mutool) مع كاش وملفات مكررة
- ✅ وضع "محادثة الملف" (PDF mode) بالدخول/الخروج
- ✅ تحويل الصوت لنص والرد صوتياً (Voxtral)
- ✅ TTS للمصطلحات الطبية + الترجمة مع نطق تلقائي
- ✅ أوامر المستخدم: `!مساعدة`, `!مسح`, `!رصيد`, `!لغة`, `!ملخص`
- ✅ أوامر الأدمن عبر واتساب: `!addvip`, `!removevip`, `!resetlimit`
- ✅ لوحة تحكم كاملة: نظرة عامة، المستخدمون، الاستهلاك، الحدود، VIP، المحظورون، البث، البلاغات
- ✅ البث الجماعي مع rate-limiting
- ✅ كل بيانات `bot_data.json` ونظام الحفظ (debounced save)

## 7. ما تغيّر (Baileys → Cloud API)

| القديم (Baileys) | الجديد (Cloud API) |
|---|---|
| QR Code لتسجيل الدخول | Access Token + Phone Number ID (بلا QR) |
| `sock.sendMessage` | `wa.sendText` / `wa.sendReply` |
| `sock.sendMessage({react})` | `wa.sendReaction` |
| `downloadMediaMessage` | `wa.downloadMedia(mediaId)` |
| `messages.upsert` event | Webhook POST `/webhook` |
| جلسة `./session` محلية | لا حاجة لها — تم حذفها بالكامل |
| `MISTRAL_API_KEY` مكتوب في الكود | يُقرأ من `.env` (أكثر أماناً) |

## 8. الأمان

- التوكن والمفاتيح الآن في `.env` (لا تشاركه أو ترفعه إلى GitHub)
- أضف `.env` إلى `.gitignore`
- استخدم System User Token دائم لتجنب انقطاع البوت كل 24 ساعة
