FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js media.js cellular-relay.js transcode.js speech-ledger.js whatsapp-video.js recordings.js recordings-routes.js recordings-mp4.js recordings-local.js recordings-metadata.js recordings-transport.js recordings-download.js ./
ENV PORT=8090
CMD ["node", "server.js"]
