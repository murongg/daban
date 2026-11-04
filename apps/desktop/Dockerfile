FROM node:24.22.1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth x11-utils dbus-x11 openbox tint2 xterm thunar mousepad chromium \
    libgtk-3-0 libnss3 libasound2 libgbm1 libxtst6 libxrandr2 libxinerama1 \
    fonts-noto-cjk fonts-liberation ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/daban
COPY . .
RUN npm ci --no-audit --no-fund \
    && npm run build:agent \
    && npm run build --workspace @daban/desktop \
    && chown root:root node_modules/electron/dist/chrome-sandbox \
    && chmod 4755 node_modules/electron/dist/chrome-sandbox \
    && mkdir -p /data/daban && chmod 700 /data/daban && chown -R node:node /data
ENV DABAN_AGENT_NODE=/usr/local/bin/node \
    DABAN_AGENT_ENTRY=/opt/daban/dist-agent/main.js \
    DABAN_CLOUD_DATA=/data/daban
USER node
ENTRYPOINT ["/usr/bin/tini", "--", "dbus-run-session", "--"]
CMD ["node", "--experimental-strip-types", "tools/cloud.ts"]
