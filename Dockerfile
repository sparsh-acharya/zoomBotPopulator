# Official Playwright image — bundles Chromium + all system libraries, pinned to
# the same Playwright version as package.json so the browser always matches.
FROM mcr.microsoft.com/playwright:v1.61.0-jammy

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first for better layer caching. Browsers are already in
# the base image (PLAYWRIGHT_BROWSERS_PATH=/ms-playwright), so no download here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY server ./server
COPY public ./public

EXPOSE 3000

# Run as the non-root user provided by the Playwright image.
USER pwuser

CMD ["node", "server/index.js"]
