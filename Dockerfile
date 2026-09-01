# Josi CE application image. One image, two commands: the API and the worker.
#
# Built for linux/amd64 and linux/arm64 from this same file — CE targets old
# 64-bit hardware and low-power ARM devices, so the image must stay lean and
# must not depend on anything architecture-specific.

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Dependency install is its own layer so a source change does not re-resolve the
# tree. --ignore-scripts is deliberate: no dependency gets to run code at
# install time. @node-rs/argon2 ships prebuilt native binaries per platform, so
# it needs no build step on either architecture.
COPY package.json package-lock.json ./
# EVERY workspace must be listed here. npm creates the node_modules symlink for
# a workspace only if its package.json exists at install time, so a missing line
# here becomes "cannot find module @josi-ce/x" during the build — which is
# exactly how Phase 4 broke the image while `tsc -b` passed locally against an
# already-linked tree.
COPY packages/core/package.json packages/core/
COPY packages/auth/package.json packages/auth/
COPY packages/llm/package.json packages/llm/
COPY packages/agent/package.json packages/agent/
COPY packages/connectors/package.json packages/connectors/
COPY packages/mail/package.json packages/mail/
COPY packages/storage/package.json packages/storage/
COPY packages/ops/package.json packages/ops/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npx tsc -b

# The web bundle. Built here rather than committed, so what ships is always
# built from the source in this image — and the API serves it from its own
# origin, which is why the app needs no cross-origin cookie story at all.
RUN npm run build --workspace @josi-ce/web

# Drop dev dependencies from what gets copied forward. Done here rather than in
# the runtime stage so the runtime image never contains a package manager cache.
RUN npm prune --omit=dev --ignore-scripts

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime

# tini reaps zombies and forwards signals, so `docker stop` is a clean shutdown
# rather than a ten-second wait for SIGKILL. curl is here for the container
# healthcheck. postgresql-client is here for backup and restore — without it the
# backup feature could only return "not available", which is a worse answer than
# a slightly larger image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl postgresql-client \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Josi's own writable areas, created in the IMAGE and owned by the runtime user.
#
# Docker seeds a fresh named volume from the image path it is mounted over,
# ownership included. Without these, the volume directories are created by the
# daemon as root:root 0755, the application runs as `node`, and every backup
# fails with a permission error on a real installation — which is exactly what
# the first runtime run found while every unit test passed.
RUN mkdir -p /data/backups /data/diagnostics /data/versions \
 && chown -R node:node /data

# The `node` user (uid 1000) ships with the base image. Everything below runs as
# it: the application never needs to write to its own code, so the whole tree is
# owned by root and readable — not writable — by the runtime user.
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/packages ./packages
COPY --from=build --chown=root:root /app/apps ./apps
COPY --from=build --chown=root:root /app/package.json ./package.json
# The built SPA. `WEB_DIR` points the API at it; absent, the API serves no UI.
COPY --from=build --chown=root:root /app/apps/web/dist ./web

USER node

# No MASTER_KEY_FILE ENV here on purpose.
#
# It would only ever hold a PATH, never key material — but BuildKit's
# SecretsUsedInArgOrEnv check flags any ENV whose name looks secret-ish, and the
# honest fix is to remove the line rather than suppress the check. Suppressing
# it file-wide would also hide a genuine secret-in-ENV mistake later.
#
# Nothing is lost: the default lives in code (core/masterKey.ts,
# DEFAULT_MASTER_KEY_PATH) and compose sets the variable explicitly for the
# services that need it.

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
