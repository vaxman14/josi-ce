# Hey Josi hosted service. Build from the repository root:
#   docker build -f apps/hosted/Dockerfile -t heyjosi-hosted .
FROM node:22-bookworm-slim AS build
WORKDIR /app
# npm links a workspace only if its package.json is here at install time, and
# `npm ci` checks them all against the lockfile. Keep this in step with the root
# Dockerfile's list. --ignore-scripts: no dependency runs code at install time.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/automation/package.json packages/automation/
COPY packages/tunnel/package.json packages/tunnel/
COPY packages/core/package.json packages/core/
COPY packages/auth/package.json packages/auth/
COPY packages/llm/package.json packages/llm/
COPY packages/agent/package.json packages/agent/
COPY packages/connectors/package.json packages/connectors/
COPY packages/mail/package.json packages/mail/
COPY packages/storage/package.json packages/storage/
COPY packages/ops/package.json packages/ops/
COPY packages/persona/package.json packages/persona/
COPY packages/channels/package.json packages/channels/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
COPY apps/hosted/package.json apps/hosted/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/tunnel packages/tunnel
COPY packages/core packages/core
COPY packages/auth packages/auth
COPY apps/hosted apps/hosted
RUN npx tsc -b apps/hosted && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/packages/tunnel/package.json packages/tunnel/package.json
COPY --from=build /app/packages/tunnel/dist packages/tunnel/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/auth/package.json packages/auth/package.json
COPY --from=build /app/packages/auth/dist packages/auth/dist
COPY --from=build /app/apps/hosted/package.json apps/hosted/package.json
COPY --from=build /app/apps/hosted/dist apps/hosted/dist
COPY --from=build /app/apps/hosted/public apps/hosted/public
COPY --from=build /app/apps/hosted/supabase apps/hosted/supabase
USER node
EXPOSE 8080
# Apply migrations as their own step: node apps/hosted/dist/migrate.js
CMD ["node", "apps/hosted/dist/server.js"]
