#!/bin/bash
# Install Josi from this folder, with no download: the folder holds the
# one-command installer (`linux`) and the packages it checks by SHA-256.
#
#   sudo ./install.sh            asks its questions, like curl … | sudo bash
#   sudo ./install.sh --yes      takes the defaults (see --help for flags)
#
# Copy the whole folder to another machine (scp -r, a USB stick) and run it
# there the same way. Josi itself still needs the internet afterwards for its
# models, and her own browser downloads Chrome for Testing once.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
exec bash "$here/linux" --from "$here" "$@"
