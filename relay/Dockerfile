# Kashu's relay and keeper (one image, two containers). Built from the repo root:
#   docker build -f relay/Dockerfile -t kashu-relay .
FROM node:22-slim
WORKDIR /app
COPY relay/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY relay/relay.mjs relay/keeper.mjs relay/push.mjs ./relay/
COPY client/vault.mjs client/rooms.mjs client/bytes.mjs client/markets.mjs ./client/
USER node
ENV HOST=0.0.0.0 PORT=8830 NODE_ENV=production
EXPOSE 8830
CMD ["node", "relay/relay.mjs"]
