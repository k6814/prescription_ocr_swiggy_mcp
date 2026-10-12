# Instamart cart backend.
#
# Plain Node, no build step -- the whole app is ESM source. The only thing that must survive
# a redeploy is /app/data: it holds every user's AES-encrypted Swiggy tokens and the OAuth
# client registration. Mount a volume there or everyone is silently signed out on each deploy.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# `npm ci` when a lockfile is present so builds are reproducible; fall back if it is absent.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# curl is used by the container healthcheck below.
RUN apk add --no-cache curl

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Operational commands you will want on the server: `docker exec <ctr> npm run add-user -- --list`,
# `-- --remove <id>`, and inspect-shapes when Swiggy changes a field name.
COPY scripts ./scripts

# The data directory is a mount point. Created and owned by `node` up front so the app can
# write to it when the container drops privileges.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "src/server.js"]
