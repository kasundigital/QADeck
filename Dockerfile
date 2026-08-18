FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm install --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm

COPY . .
RUN mkdir -p /app/data/artifacts && chown -R node:node /app

USER node
EXPOSE 3000

CMD ["npm", "start"]
