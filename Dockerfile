FROM node:24-alpine

RUN apk add --no-cache redis tini

WORKDIR /app

COPY package.json ./
# npm is only needed to install. Removing it drops its bundled packages and their CVEs.
RUN npm install --omit=dev \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY server.js ./
COPY public ./public
COPY start.sh ./
RUN chmod +x start.sh

ENV REDIS_URL=redis://127.0.0.1:6379
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./start.sh"]
