# صورة Node.js رسمية على Ubuntu — تدعم apt-get كامل
FROM node:20-bullseye-slim

# تثبيت ffmpeg و mupdf-tools (يحتوي mutool)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        mupdf-tools \
        fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# مجلد العمل
WORKDIR /app

# نسخ package.json أولاً (caching أفضل)
COPY package*.json ./
RUN npm install --production

# نسخ باقي الملفات
COPY . .

# منع رفع .env و node_modules
# (يجب أن يكون .dockerignore موجوداً)

EXPOSE 8080

CMD ["node", "bot.js"]
