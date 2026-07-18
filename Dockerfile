FROM node:20-alpine

RUN apk add --no-cache redis tini

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
COPY start.sh ./
RUN chmod +x start.sh

ENV REDIS_URL=redis://127.0.0.1:6379
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./start.sh"]
