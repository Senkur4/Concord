# Bot de música do Concord: Node + ffmpeg + yt-dlp
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/ytdlp \
    && /opt/ytdlp/bin/pip install --no-cache-dir -U "yt-dlp[default]"
ENV PATH="/opt/ytdlp/bin:$PATH" NODE_ENV=production
WORKDIR /bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bot.mjs ./
# atualiza o yt-dlp a cada vez que o bot liga (o YouTube muda e versões velhas param de funcionar)
CMD ["sh", "-c", "pip install -q -U --disable-pip-version-check 'yt-dlp[default]' >/dev/null 2>&1; exec node bot.mjs"]
