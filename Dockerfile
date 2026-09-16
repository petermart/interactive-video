# Escape from Slop Prison: Bun server + ffmpeg. Deploy on Railway (or any Docker host) with a volume mounted at /data.
FROM oven/bun:1.3-debian

# ffmpeg/ffprobe: last-frame extraction, reference downscaling, film export.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

COPY . .

# Writable state (generated clips, exports, settings, debug DB) lives on the mounted volume.
ENV NODE_ENV=production \
    STORAGE_DIR=/data \
    PORT=3000
RUN mkdir -p /data

EXPOSE 3000
CMD ["bun", "src/index.ts"]
