FROM node:24-bookworm-slim AS build
WORKDIR /source
COPY package.json package-lock.json ./
COPY apps/ ./apps/
COPY packages/ ./packages/
COPY tools/ ./tools/
RUN npm ci --ignore-scripts --no-audit --no-fund --workspace @daban/gallery --workspace @daban/engine --workspace @daban/protocol --include-workspace-root
COPY LICENSE ./LICENSE
RUN npm run build:gallery && node --experimental-strip-types tools/gallery.ts

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /source/outputs/gallery-standalone/ ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -m 700 /data && chown node:node /data
ENV GALLERY_DATA_DIR=/data GALLERY_PORT=8080 GALLERY_READ_MODE=private
USER node
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["node", "main.js"]
