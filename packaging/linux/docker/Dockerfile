# Josi's Linux server in one Docker container: Debian 13 with systemd, so it is
# the same server the one-command installer sets up on a real machine (the
# same package, the same six isolated services, the same web updater), plus
# the PC-control service and Josi's own browser, working as the container's
# `josi` user. The container is the computer Josi controls.
#
#   docker build -t josi -f Dockerfile <folder holding josi_*_amd64.deb or josi_*_arm64.deb>
#   docker run -d -t --name josi --privileged --cgroupns=host \
#     -v josi-data:/var/lib/josi -v josi-pc:/var/lib/josi-pc -v josi-home:/home/josi \
#     -v josi-etc:/etc/josi -p 8080:8080 -e JOSI_HOST_ADDRESS=<this machine's address> josi
#   docker logs josi            # prints the one-time setup link
#
# See packaging/linux/docker/README.md.
FROM debian:13

ENV container=docker DEBIAN_FRONTEND=noninteractive

# systemd as PID 1, what the package needs, and what Josi's own browser needs
# (a hidden screen, a window manager, screenshot and click tools, libraries
# for Chrome). Debian 13 uses the t64 names.
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus sudo curl ca-certificates procps iproute2 \
      python3 rsync acl libstdc++6 unzip \
      xvfb xauth openbox xdotool wmctrl imagemagick fonts-liberation fonts-noto-color-emoji \
      libnss3 libgbm1 libxkbcommon0 libxss1 libdrm2 libxcomposite1 libxdamage1 libxrandr2 libxshmfence1 \
      libpango-1.0-0 libcairo2 libasound2t64 libgtk-3-0t64 libcups2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libglib2.0-0t64 \
    && rm -rf /var/lib/apt/lists/* \
    && find /usr/lib/systemd/system /etc/systemd/system -path '*.wants/*' \
         \( -name '*getty*' -o -name '*udev*' -o -name '*update-utmp*' -o -name '*timesyncd*' -o -name '*apt-daily*' \) -delete \
    && systemctl mask getty.target console-getty.service systemd-udevd.service systemd-udev-trigger.service \
         systemd-timesyncd.service apt-daily.timer apt-daily-upgrade.timer

# The user Josi acts as: her PC control runs as this account, with its permissions.
RUN useradd --create-home --shell /bin/bash --uid 1000 josi

# The package is installed into the image; the first start configures and
# starts it (systemd is not running during a build).
# TARGETARCH is amd64 or arm64, whichever the image is built for
# (docker build --platform linux/arm64 for a Raspberry Pi). ARM has no Chrome
# for Testing for Linux, so there Josi's browser is Debian's Chromium.
ARG TARGETARCH
COPY josi_*_${TARGETARCH}.deb /tmp/
RUN apt-get update && apt-get install -y --no-install-recommends /tmp/josi_*_${TARGETARCH}.deb \
      $([ "$TARGETARCH" = arm64 ] && echo chromium) \
    && rm -rf /var/lib/apt/lists/* /tmp/josi_*_${TARGETARCH}.deb

COPY josi-firstboot.sh /usr/local/sbin/josi-firstboot
COPY josi-adopt.py /usr/local/sbin/josi-adopt.py
COPY josi-firstboot.service /etc/systemd/system/josi-firstboot.service
# The container is privileged, so its systemd would reach the host's kernel
# settings. Its binfmt service clears the host's list of program formats
# (which switches off ARM emulation and the like on the host), so it is off.
RUN chmod 0755 /usr/local/sbin/josi-firstboot && systemctl enable josi-firstboot.service \
    && systemctl mask systemd-binfmt.service proc-sys-fs-binfmt_misc.automount proc-sys-fs-binfmt_misc.mount

# Data survives the container: the database and settings, Josi's browser and
# her PC identity, the Josi user's files.
VOLUME ["/var/lib/josi", "/var/lib/josi-pc", "/etc/josi", "/home/josi"]
EXPOSE 8080
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
