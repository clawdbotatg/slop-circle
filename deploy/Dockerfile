# The whole circle app is one process: the relay serves the built client.
# Multi-stage — build the Vite client + compile the relay, then run a slim
# image with just node_modules + the two dist/ trees.

FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY relay/package.json relay/
COPY web/package.json web/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build -w web && npm run build -w relay

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/relay/dist ./relay/dist
COPY --from=build /app/relay/package.json ./relay/package.json
COPY --from=build /app/web/dist ./web/dist
# The relay reads config from the environment (see relay/src/config.ts).
ENV CIRCLE_WEB_DIST=/app/web/dist
ENV CIRCLE_DATA_DIR=/data
ENV PORT=8788
EXPOSE 8788
CMD ["node", "relay/dist/index.js"]
