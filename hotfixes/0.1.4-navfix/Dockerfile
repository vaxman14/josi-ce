ARG BASE_IMAGE=ghcr.io/vaxman14/josi-ce@sha256:1b9280f4ce1f447787ca6499687be020986a56c68dde808325a8cd681f29beee
FROM ${BASE_IMAGE}

ARG JOSI_BUILD_ID=unknown
USER root
COPY hotfixes/0.1.4-navfix/patch-assets.mjs /tmp/patch-assets.mjs
RUN node /tmp/patch-assets.mjs && rm /tmp/patch-assets.mjs
LABEL org.opencontainers.image.version="0.1.4-navfix.1" \
      org.opencontainers.image.revision="${JOSI_BUILD_ID}" \
      org.opencontainers.image.description="Josi CE 0.1.4 with only the duplicate member Telegram navigation entry removed"
USER node
