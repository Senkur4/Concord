# Bot de filmes do Concord: Node + ffmpeg (com libass para as legendas e zimg para vídeos HDR)
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation fontconfig ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bot.mjs ./
CMD ["node", "bot.mjs"]
