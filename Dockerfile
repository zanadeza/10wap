FROM node:20-bullseye-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        mupdf-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 8080
CMD ["node", "bot.js"]
