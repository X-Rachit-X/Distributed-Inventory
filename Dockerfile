# One image for every backend service; the SERVICE build argument chooses which
# entry point it runs.
#
# Trade-off, stated: a per-service image would be smaller, but the services share
# a workspace package (@tessera/shared) and a lockfile, and one image keeps
# dependency versions identical everywhere. For eight small Node services the
# size difference is a few megabytes.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services services
COPY lab/package.json lab/
COPY bench/package.json bench/
COPY apps/console/package.json apps/console/
RUN npm ci --omit=dev --ignore-scripts --workspaces --include-workspace-root

FROM node:22-alpine
ARG SERVICE
ENV NODE_ENV=production SERVICE_ENTRY=services/${SERVICE}/src/index.js
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY packages packages
COPY services services
# Unprivileged user: a compromised service should not own its container.
USER node
EXPOSE 4000-4007
CMD ["sh", "-c", "node $SERVICE_ENTRY"]
