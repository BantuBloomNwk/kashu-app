# Kashu's agent service: the private AI chat (NEAR AI Cloud, attested). Built from the repo root:
#   docker build -f agent/Dockerfile -t kashu-agent .
FROM node:22-slim
WORKDIR /app
COPY agent/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY agent/attest.mjs agent/brain.mjs agent/server.mjs agent/tee.mjs ./
USER node
ENV HOST=0.0.0.0 PORT=8831 NODE_ENV=production
EXPOSE 8831
CMD ["node", "server.mjs"]
