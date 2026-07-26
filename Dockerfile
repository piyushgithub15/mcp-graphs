### Build stage — compiles TypeScript and copies the view templates dist/ expects.
FROM node:20-alpine AS build
WORKDIR /app
# Skip puppeteer's own Chromium download here too — the runtime stage's
# apk-installed chromium is what actually gets used, and this build stage
# never launches a browser, so there's no point fetching one.
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

### Runtime stage — production deps only, no TypeScript toolchain.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Headless Chromium (+ fonts) used by render_chart/render_diagram to
# screenshot the chart/diagram view server-side, so the PNG shipped in a
# tool result matches what a real MCP Apps host would draw.
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
