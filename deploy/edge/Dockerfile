# The edge image: the console's production build served by Caddy, which also
# proxies /api to the gateway and terminates TLS.
#
#   docker build -f deploy/edge/Dockerfile -t tessera/edge .
#
# Build context is the repository root (the console is an npm workspace and
# needs the root lockfile).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Every workspace manifest, so `npm ci` sees the same tree as the lockfile.
COPY packages/shared/package.json packages/shared/
COPY services services
COPY lab/package.json lab/
COPY bench/package.json bench/
COPY apps/console/package.json apps/console/
RUN npm ci --workspace @tessera/console --include-workspace-root=false
COPY apps/console apps/console
RUN npm run build --workspace @tessera/console

FROM caddy:2-alpine
COPY deploy/edge/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/console/dist /srv
