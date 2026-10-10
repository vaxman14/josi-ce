FROM debian:12-slim@sha256:f3034a6ec3c1205360777c4aae76234998866ad18806ae62b63a3f84ccad782b

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && printf 'Types: deb\nURIs: https://snapshot.debian.org/archive/debian/20261001T000000Z/\nSuites: bookworm\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\nCheck-Valid-Until: no\n' > /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends build-essential bzip2 cmake libopenblas-pthread-dev rpm rsync xz-utils zstd \
    && rm -rf /var/lib/apt/lists/*
