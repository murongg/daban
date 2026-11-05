FROM node:24.22.1-bookworm AS build
WORKDIR /opt/daban
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY . .
RUN npm ci --no-audit --no-fund \
    && npm run build:engine \
    && npm run build --workspace @daban/connect \
    && npx rolldown dist-connect/main.js --platform node --format esm --file /srv/main.mjs --external ws

FROM node:24.22.1-bookworm-slim
WORKDIR /srv
COPY --from=build /srv/main.mjs ./main.mjs
COPY --from=build /opt/daban/node_modules/ws ./node_modules/ws
ENV HOST=0.0.0.0 PORT=8787
USER node
EXPOSE 8787
CMD ["node", "main.mjs"]
