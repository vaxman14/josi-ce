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
COPY packages/core/package.json packages/core/
COPY packages/auth/package.json packages/auth/
COPY apps/api/package.json apps/api/
RUN npm ci --ignore-scripts

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npx tsc -b

# Drop dev dependencies from what gets copied forward. Done here rather than in
# the runtime stage so the runtime image never contains a package manager cache.
RUN npm prune --omit=dev --ignore-scripts

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime

# tini reaps zombies and forwards signals, so `docker stop` is a clean shutdown
# rather than a ten-second wait for SIGKILL. curl is here for the container
# healthcheck and nothing else.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# The `node` user (uid 1000) ships with the base image. Everything below runs as
# it: the application never needs to write to its own code, so the whole tree is
# owned by root and readable — not writable — by the runtime user.
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/packages ./packages
COPY --from=build --chown=root:root /app/apps ./apps
COPY --from=build --chown=root:root /app/package.json ./package.json

USER node

# The master key is NOT baked in, NOT an env var, and NOT in any layer. It is
# mounted at runtime as a Docker secret; this only names the path.
ENV MASTER_KEY_FILE=/run/secrets/josi_master_key

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/server.js"]
