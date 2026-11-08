#!/bin/bash
# One-command installer for the Josi server on Linux:
#
#   curl -fsSL https://<install host>/linux | sudo bash
#
# It finds the distribution (pacman or apt), installs what Josi needs, checks
# the package's SHA-256 against this script, installs the package and starts
# josi.service. Run it again at any time: it repairs or updates the install
# and prints a fresh address. Everything after that happens in the browser.
#
# In a terminal it shows its progress on stderr: the ghost, each step with a
# spinner and its time, the download in megabytes, and one bar for the whole
# install, in Josi's Plum & Gold. stdout only ever carries one line, the
# address to open, so `address=$(curl -fsSL .../linux | sudo bash)` works.
# With no terminal, or with JOSI_QUIET=1 or NO_COLOR set, that line is all it
# prints. Every detail goes to /var/log/josi-install.log.
#
# This file is a template: scripts/linux/build-headless-installer.py fills in
# the version, the download address and the package hashes of one release.
# Everything runs from main at the bottom, so a cut-off download runs nothing.
set -euo pipefail

VERSION=@VERSION@
BASE_URL=@BASE_URL@
# family processor file sha256, one package per line; "-" marks one not built.
PACKAGES='@PACKAGES@'

log=/var/log/josi-install.log
work=''
bgpid=''
processor='' family='' package='' expected='' url=''

# ---------------------------------------------------------------- the steps

NAMES=('Checking this machine' 'Installing what Josi needs' 'Downloading Josi'
       'Checking the download' 'Installing Josi' 'Starting Josi')
WEIGHT=(2 12 45 4 22 15)  # each step's share of the whole bar; adds up to 100
EXPECT=(1 20 60 4 40 25)  # seconds, for steps that cannot report their progress
STATE=(wait wait wait wait wait wait)
START=(0 0 0 0 0 0)
TOOK=(0 0 0 0 0 0)
cur=-1
size=0 rate=0 rate_at=0 rate_got=0
FRAC=0 PCT=0 DETAIL=''

# ---------------------------------------------------------------- the screen

screen=0 drawn=0 tick=0 lastf='' dirty=0 final=0
rows=24 cols=80 utf8=0 truecolor=0 GL=0 REGION=10 BW=40
RST='' BOLD='' DIM='' GOLD='' LILAC='' GREEN='' RED='' EMPTYC=''
SPIN=('|' '/' '-' '\') OK='+' NO='x' DOT='-' FULL='#' EMPTY='-'
HEAD=() BARC=()
declare -A GH=() FG=() BG=()

# The ghost, 18 pixels wide and 20 tall, drawn two pixels per character with
# half blocks: the curl on top, a lilac head, dark eyes with a shine, cheeks,
# a small smile, little arms and a teal tail.
# u/t curl, l lilac, b white, q teal, h arms, e eyes, w shine,
# m mouth, c cheeks.
GW=18
GROWS=(
  '..........ttt.....'
  '.........u...t....'
  '.............t....'
  '...........uu.....'
  '.......lllllu.....'
  '.....llllllllll...'
  '....llllllllllll..'
  '...lllllllllllll..'
  '...llewllllllewl..'
  '...lleelllllleel..'
  '..bbcbbbbmmbbbbcb.'
  'hhbbbbbbbbbbbbbbhh'
  '.hbbbbbbbbbbbbbbh.'
  '..bbbbbbbbbbbbbb..'
  '..qbbbbbbbbbbbbb..'
  '..qqbbbbbbbbbbbl..'
  '..qqqbbbbbbbbbll..'
  '...qqbbbbbbbbll...'
  '...qq.bbbb.bbl....'
  '....q...bb..l.....'
)
declare -A RGB=([u]='200;176;240' [t]='150;210;214' [l]='226;214;250' [b]='255;250;244'
  [q]='170;226;222' [h]='240;222;250' [e]='60;36;30' [w]='255;255;255' [m]='214;100;100' [c]='250;176;170'
  [G]='240;207;122' [L]='185;160;189' [ok]='143;217;168' [no]='232;116;106')
declare -A C256=([u]=183 [t]=116 [l]=189 [b]=231 [q]=152 [h]=225 [e]=236 [w]=231 [m]=167 [c]=217
  [G]=222 [L]=182 [ok]=114 [no]=167)

setup_colors() {
  local k
  case "${COLORTERM:-}" in truecolor|24bit) truecolor=1 ;; esac
  case "${TERM:-}" in *-direct|xterm-kitty|alacritty|wezterm|foot*|xterm-ghostty) truecolor=1 ;; esac
  for k in "${!RGB[@]}"; do
    if [ "$truecolor" = 1 ]; then
      FG[$k]=$'\e[38;2;'"${RGB[$k]}m"; BG[$k]=$'\e[48;2;'"${RGB[$k]}m"
    else
      FG[$k]=$'\e[38;5;'"${C256[$k]}m"; BG[$k]=$'\e[48;5;'"${C256[$k]}m"
    fi
  done
  RST=$'\e[0m' BOLD=$'\e[1m' DIM=$'\e[2m'
  GOLD=${FG[G]} LILAC=${FG[L]} GREEN=${FG[ok]} RED=${FG[no]}
  return 0
}

# Six pictures: three heights for the float, each with eyes open and closed.
make_frames() {
  local blink i off y x a b s row
  local -a r seq=(0 1 2 1)
  local blank='..................'
  for blink in 0 1; do
    for i in 0 1 2 3; do
      off=${seq[i]}
      r=()
      for ((y = 0; y < off; y++)); do r+=("$blank"); done
      for ((y = 0; y < ${#GROWS[@]}; y++)); do
        row=${GROWS[y]}
        if [ "$blink" = 1 ]; then
          case $y in
            8) row=${row//[ew]/l} ;;
          esac
        fi
        r+=("$row")
      done
      while [ ${#r[@]} -lt 22 ]; do r+=("$blank"); done
      for ((y = 0; y < 22; y += 2)); do
        s=''
        for ((x = 0; x < GW; x++)); do
          a=${r[y]:x:1}; b=${r[y + 1]:x:1}
          if [ "$a" = . ]; then
            if [ "$b" = . ]; then s+="$RST "; else s+="$RST${FG[$b]}▄"; fi
          elif [ "$b" = . ]; then
            s+="$RST${FG[$a]}▀"
          else
            s+="${FG[$a]}${BG[$b]}▀"
          fi
        done
        GH["$((i + 4 * blink)),$((y / 2))"]="$s$RST"
      done
    done
  done
  return 0
}

# The bar runs lilac to gold to teal, like the ghost.
make_bar() {
  local j t r g b
  local -a stops=(183 183 182 218 224 223 222 222 187 152 116 116)
  BARC=()
  for ((j = 0; j < BW; j++)); do
    if [ "$truecolor" = 1 ]; then
      t=$((j * 1000 / (BW > 1 ? BW - 1 : 1)))
      if [ "$t" -le 500 ]; then
        r=$((205 + 50 * t / 500)); g=$((180 + 34 * t / 500)); b=$((240 - 100 * t / 500))
      else
        t=$((t - 500)); r=$((255 - 97 * t / 500)); g=214; b=$((140 + 76 * t / 500))
      fi
      BARC+=($'\e[38;2;'"$r;$g;${b}m")
    else
      BARC+=($'\e[38;5;'"${stops[j * 12 / BW]}m")
    fi
  done
  if [ "$truecolor" = 1 ]; then EMPTYC=$'\e[38;2;74;52;82m'; else EMPTYC=$'\e[38;5;239m'; fi
  return 0
}

init_screen() {
  local tty_size osname
  [ -t 2 ] || return 0
  [ "${JOSI_QUIET:-0}" != 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ] || return 0
  tty_size=$(stty size </dev/tty 2>/dev/null || true)
  case $tty_size in *' '*) rows=${tty_size% *} cols=${tty_size#* } ;; esac
  case $rows in '' | *[!0-9]*) rows=24 ;; esac
  case $cols in '' | *[!0-9]*) cols=80 ;; esac
  [ "$rows" -gt 0 ] || rows=24
  [ "$cols" -gt 0 ] || cols=80
  [ "$cols" -ge 50 ] || return 0
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in *UTF-8* | *utf-8* | *utf8* | *UTF8*) utf8=1 ;; esac
  setup_colors
  if [ "$utf8" = 1 ]; then
    SPIN=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) OK='✓' NO='✗' DOT='·' FULL='━' EMPTY='━'
  fi
  osname=$( (. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-}") || true)
  [ -n "$osname" ] || osname=Linux
  osname="$osname · $processor"
  if [ "$utf8" = 1 ] && [ "$cols" -ge 72 ] && [ "$rows" -ge 24 ]; then
    GL=11 REGION=20
    make_frames
    HEAD=('' '' '' ''
      "${BOLD}${GOLD}Josi${RST}  ${LILAC}${VERSION}${RST}"
      "${LILAC}Your own assistant, on your own machine.${RST}"
      "${DIM}${osname:0:$((cols - 30))}${RST}"
      '' '' '' '')
  else
    GL=0 REGION=10
    HEAD=("${BOLD}${GOLD}Josi${RST} ${LILAC}${VERSION}${RST}  ${DIM}${osname:0:$((cols - 20))}${RST}")
  fi
  BW=$((cols - 12)); [ "$BW" -le 52 ] || BW=52
  make_bar
  screen=1
  printf '\e[?25l\n' >&2
  draw
  return 0
}

dur() {
  if [ "$1" -lt 60 ]; then REPLY="$1s"; else printf -v REPLY '%dm %02ds' $(($1 / 60)) $(($1 % 60)); fi
  return 0
}

mb() { REPLY=$(($1 / 1048576)); return 0; }

# How far the running step is (FRAC, 0 to 1000) and what to say about it.
progress() {
  local e x got kind pkg pct msg n i s
  FRAC=0 DETAIL=''
  [ "$cur" -ge 0 ] || return 0
  e=$((SECONDS - START[cur])) x=${EXPECT[cur]}
  if [ "$cur" = 2 ] && [ -n "$work" ]; then
    got=$(stat -c %s "$work/$package" 2>/dev/null || echo 0)
    if [ "$SECONDS" -gt "$rate_at" ]; then
      rate=$(((got - rate_got) / (SECONDS - rate_at))) rate_at=$SECONDS rate_got=$got
    fi
    mb "$got"; DETAIL="$REPLY"
    if [ "$size" -gt 0 ]; then
      FRAC=$((got * 1000 / size)); [ "$FRAC" -le 1000 ] || FRAC=1000
      mb "$size"; DETAIL+=" / $REPLY MB"
      if [ "$cols" -ge 96 ]; then
        n=$((FRAC * 12 / 1000)) s=''
        for ((i = 0; i < 12; i++)); do
          if [ "$i" -lt "$n" ]; then s+="$GOLD$FULL"; else s+="$EMPTYC$EMPTY"; fi
        done
        DETAIL="${s}${RST}${LILAC} $DETAIL"
      fi
    else
      DETAIL+=' MB'
    fi
    if [ "$rate" -ge 1048576 ]; then mb "$rate"; DETAIL+=" · $REPLY MB/s"
    elif [ "$rate" -gt 0 ]; then DETAIL+=" · $((rate / 1024)) KB/s"; fi
    [ "$size" -eq 0 ] || return 0
  elif [ -n "$work" ] && [ -s "$work/status" ]; then
    # apt reports pmstatus:<package>:<percent>:<what it is doing>.
    IFS=: read -r kind pkg pct msg < <(grep -E '^(pm|dl)status:' "$work/status" | tail -n 1) || true
    pct=${pct%%.*}
    case $pct in '' | *[!0-9]*) ;; *)
      FRAC=$((pct * 10))
      DETAIL=${msg:0:$((cols - 45 > 0 ? cols - 45 : 0))}
      return 0 ;;
    esac
  fi
  if [ "$e" -lt "$x" ]; then FRAC=$((900 * e / x)); else FRAC=$((900 + 90 * (e - x) / e)); fi
  return 0
}

step_line() {
  local i=$1 name=${NAMES[$1]} t
  case ${STATE[i]} in
    done)
      dur "${TOOK[i]}"
      printf -v REPLY '\r\e[2K  %s%s%s %-28s %s%s%s\n' "$GREEN" "$OK" "$RST" "$name" "$DIM" "$REPLY" "$RST" ;;
    run)
      dur $((SECONDS - START[i])); t=$REPLY
      printf -v REPLY '\r\e[2K  %s%s%s %s%-28s%s %s%s%s %s%s%s\n' "$GOLD" "${SPIN[tick % ${#SPIN[@]}]}" "$RST" \
        "$BOLD" "$name" "$RST" "$LILAC" "$DETAIL" "$RST" "$DIM" "$t" "$RST" ;;
    fail)
      printf -v REPLY '\r\e[2K  %s%s %s%s\n' "$RED" "$NO" "$name" "$RST" ;;
    *)
      printf -v REPLY '\r\e[2K  %s%s %s%s\n' "$DIM" "$DOT" "$name" "$RST" ;;
  esac
  return 0
}

draw() {
  [ "$screen" = 1 ] || return 0
  local i f out='' sum=0 n
  tick=$((tick + 1))
  progress
  for i in 0 1 2 3 4 5; do
    if [ "${STATE[i]}" = done ]; then sum=$((sum + WEIGHT[i])); fi
  done
  if [ "$cur" -ge 0 ]; then sum=$((sum + WEIGHT[cur] * FRAC / 1000)); fi
  [ "$sum" -le 100 ] || sum=100
  [ "$sum" -ge "$PCT" ] || sum=$PCT
  PCT=$sum
  if [ "$drawn" = 1 ]; then out+=$'\e['"${REGION}A"; fi
  if [ "$GL" -gt 0 ]; then
    f=$(((tick / 4) % 4))
    if [ $((tick % 40)) -lt 2 ]; then f=$((f + 4)); fi
    if [ "$final" = 1 ]; then f=1; fi
    if [ "$drawn" = 0 ] || [ "$f" != "$lastf" ] || [ "$dirty" = 1 ]; then
      for ((i = 0; i < GL; i++)); do out+=$'\r\e[2K  '"${GH[$f,$i]}    ${HEAD[i]}"$'\n'; done
      lastf=$f dirty=0
    else
      out+=$'\e['"${GL}B"
    fi
  else
    out+=$'\r\e[2K  '"${HEAD[0]}"$'\n'
  fi
  out+=$'\r\e[2K\n'
  for i in 0 1 2 3 4 5; do step_line "$i"; out+=$REPLY; done
  out+=$'\r\e[2K\n'
  n=$((PCT * BW / 100))
  out+=$'\r\e[2K  '
  for ((i = 0; i < BW; i++)); do
    if [ "$i" -lt "$n" ]; then out+="${BARC[i]}$FULL"; else out+="$EMPTYC$EMPTY"; fi
  done
  out+="$RST  ${BOLD}${PCT}%${RST}"$'\n'
  printf '%s' "$out" >&2
  drawn=1
  return 0
}

begin() {
  cur=$1 STATE[$1]=run START[$1]=$SECONDS DETAIL=''
  if [ -n "$work" ]; then : > "$work/status"; fi
  printf '\n== %s\n' "${NAMES[$1]}" >&3
  draw
}

finish() {
  TOOK[cur]=$((SECONDS - START[cur])) STATE[cur]=done
  cur=-1
  draw
}

# Runs a command with its output in the log. On the screen it runs in the
# background while the spinner and the bar move.
run() {
  local rc=0
  if [ "$screen" = 1 ]; then
    "$@" </dev/null >&3 2>&1 &
    bgpid=$!
    while kill -0 "$bgpid" 2>/dev/null; do draw; sleep 0.1; done
    wait "$bgpid" || rc=$?
    bgpid=''
    return "$rc"
  fi
  "$@" </dev/null >&3 2>&1
}

fail() {
  if [ "$screen" = 1 ]; then
    if [ "$cur" -ge 0 ]; then STATE[cur]=fail; fi
    if [ "$GL" -gt 0 ]; then HEAD[7]="${RED}Something went wrong.${RST}"; dirty=1; fi
    draw
    printf '\n  %s%s %s%s\n' "$RED" "$NO" "$*" "$RST" >&2
    if [ -s "$log" ]; then
      printf '\n  %sThe last lines of %s:%s\n' "$DIM" "$log" "$RST" >&2
      tail -n 8 "$log" | cut -c1-$((cols - 6)) | sed "s/^/    ${DIM}/; s/\$/${RST}/" >&2
    fi
    printf '\n  %sRun the same command again to try again.%s\n\n' "$LILAC" "$RST" >&2
  else
    printf 'Josi installer: %s\n' "$*" >&2
    if [ -s "$log" ]; then printf 'Details: %s\n' "$log" >&2; fi
  fi
  exit 1
}

cleanup() {
  if [ -n "$bgpid" ]; then kill "$bgpid" 2>/dev/null || true; fi
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  if [ "$screen" = 1 ]; then printf '\e[0m\e[?25h' >&2; fi
}

# ------------------------------------------------------------- the commands

apt_get() { apt-get -o APT::Status-Fd=4 "$@" 4>"$work/status"; }
download() {
  curl --fail --location --silent --show-error --proto "$proto" --retry 3 \
    --output "$work/$package" "$BASE_URL/$package"
}
checksum() { sha256sum "$work/$package" > "$work/sum"; }
start_josi() { /usr/bin/josi-ce-server-install 2>&3 > "$work/url"; }

main() {
  local line missing actual
  [ "$(uname -s)" = Linux ] || fail 'Linux is required'
  [ "$(id -u)" = 0 ] || fail 'run it with sudo: curl -fsSL <address>/linux | sudo bash'
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || fail 'systemd is required'

  case "$(uname -m)" in
    x86_64|amd64) processor=x86_64 ;;
    aarch64|arm64) processor=aarch64 ;;
    *) fail "this processor ($(uname -m)) is not supported" ;;
  esac

  : > "$log"; chmod 600 "$log"
  exec 3>>"$log"
  work=$(mktemp -d /var/tmp/josi-install.XXXXXX)
  chmod 755 "$work"
  trap cleanup EXIT
  trap 'exit 130' INT TERM HUP

  init_screen

  begin 0
  if command -v pacman >/dev/null 2>&1; then
    family=arch
  elif command -v apt-get >/dev/null 2>&1; then
    family=debian
  else
    fail 'this installer supports Arch (pacman) and Debian or Ubuntu (apt)'
  fi
  line=$(printf '%s\n' "$PACKAGES" | awk -v f="$family" -v p="$processor" '$1 == f && $2 == p { print; exit }')
  package=$(printf '%s' "$line" | awk '{ print $3 }')
  expected=$(printf '%s' "$line" | awk '{ print $4 }')
  [ -n "$package" ] && [ "$package" != - ] || fail "no Josi $VERSION package is built for $family on $processor yet"
  printf 'Josi %s for %s %s\n' "$VERSION" "$family" "$processor" >&3
  finish

  begin 1
  if [ "$family" = arch ]; then
    missing=$(pacman -T curl python rsync acl iproute2 || true)
    if [ -n "$missing" ]; then
      # shellcheck disable=SC2086
      run pacman -Sy --needed --noconfirm $missing || fail 'pacman could not install the dependencies'
    fi
  else
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
    run apt-get update -q || fail 'apt-get update failed'
    run apt_get install -y -q ca-certificates curl python3 rsync acl iproute2 || fail 'apt could not install the dependencies'
  fi
  finish

  begin 2
  proto='=https'
  case "$BASE_URL" in http://*) proto='=http,https' ;; esac
  size=$(curl -fsIL --proto "$proto" --max-time 20 "$BASE_URL/$package" 2>/dev/null | tr -d '\r' \
    | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }') || size=0
  case $size in '' | *[!0-9]*) size=0 ;; esac
  [ "$size" -gt 1048576 ] || size=0
  rate_at=$SECONDS rate_got=0
  run download || fail "could not download $package"
  finish

  begin 3
  run checksum || fail 'could not read the downloaded package'
  actual=$(cut -d' ' -f1 "$work/sum")
  [ "$actual" = "$expected" ] || fail 'the downloaded package did not match this installer; nothing was installed'
  finish

  begin 4
  if [ "$family" = arch ]; then
    run pacman -U --noconfirm "$work/$package" || fail 'pacman could not install the Josi package'
  else
    run apt_get install -y -q "$work/$package" || fail 'apt could not install the Josi package'
  fi
  finish

  begin 5
  run start_josi || fail 'Josi did not start'
  url=$(head -n 1 "$work/url")
  [ -n "$url" ] || fail 'Josi started but did not give an address'
  finish

  if [ "$screen" = 1 ]; then
    final=1 dirty=1
    if [ "$GL" -gt 0 ]; then HEAD[7]="${GREEN}${OK} Ready.${RST}"; fi
    draw
    case $url in
      *'#handoff='*) printf '\n  %s%s%s Open this address in a browser to set Josi up:\n\n' "$GREEN" "$OK" "$RST" >&2 ;;
      *) printf '\n  %s%s%s Josi is running. Open it at:\n\n' "$GREEN" "$OK" "$RST" >&2 ;;
    esac
  fi
  # The one line on stdout. In a terminal it is indented and in gold.
  if [ "$screen" = 1 ] && [ -t 1 ]; then
    printf '  %s%s%s\n' "$BOLD$GOLD" "$url" "$RST"
  else
    printf '%s\n' "$url"
  fi
  if [ "$screen" = 1 ]; then
    case $url in
      *'#handoff='*) printf '\n  %sThe link works once, for 10 minutes. Run the same command again for a new one.%s\n\n' "$DIM" "$RST" >&2 ;;
      *) printf '\n' >&2 ;;
    esac
  fi
}

main "$@"
