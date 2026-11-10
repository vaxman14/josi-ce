#!/bin/bash
# One-command installer for the Josi server on Linux:
#
#   curl -fsSL https://<install host>/linux | sudo bash
#   wget -qO- https://<install host>/linux | bash        (as root, e.g. Debian netinst)
#
# It finds the distribution (pacman or apt), installs what Josi needs, checks
# the package's SHA-256 against this script, installs the package and starts
# josi.service. Run it again at any time: it repairs or updates the install
# and prints a fresh address. Everything after that happens in the browser.
#
# First it asks, on the terminal (/dev/tty, since stdin is this script), how
# people reach Josi (this network, a public domain with HTTPS from the bundled
# Caddy, or the administrator's own reverse proxy), the port, and whether Josi
# may control this computer as a chosen Linux user, then shows a summary to
# confirm. The answers are saved in /etc/josi/install.json and are the
# defaults the next time. With --yes, JOSI_YES=1 or no terminal nothing is
# asked; flags, the saved answers or the defaults are used:
#
#   ... | sudo bash -s -- --yes --address-mode lan|domain|proxy --port 8080 \
#         [--lan-address IP] [--domain NAME --email ADDRESS] [--public-url https://HOST] \
#         [--pc-control-user USER | --no-pc-control] [--browser | --no-browser]
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
interrupted=0
processor='' family='' package='' expected='' url='' FROM_DIR=''
# Every apt-get waits up to ten minutes for another apt (unattended-upgrades).
APT_LOCK='DPkg::Lock::Timeout=600'

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

screen=0 can_screen=0 drawn=0 tick=0 lastf='' dirty=0 final=0
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
  # sudo-rs (Ubuntu 26.04) runs this script outside the terminal's foreground
  # process group, where the kernel stops anything that touches the terminal
  # settings. Ignoring SIGTTOU and SIGTTIN, which children inherit, keeps the
  # size query and the screen from freezing; the timeout is a second guard.
  trap '' TTOU TTIN
  tty_size=$(timeout -s KILL 2 stty size <&2 2>/dev/null || true)
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
  can_screen=1
  return 0
}

# The progress screen starts once the questions are answered.
start_screen() {
  [ "$can_screen" = 1 ] || return 0
  screen=1
  printf '\e[?25l\n' >&2 2>/dev/null || screen=0
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
  # A dropped SSH session leaves a terminal that refuses writes; the install
  # goes on without its screen instead of stopping half-way.
  printf '%s' "$out" >&2 2>/dev/null || screen=0
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

# Stops a step and everything it started (Ctrl-C). The lifecycle records an
# interrupted upgrade for recovery, and the next run finishes dpkg's work and
# rolls the upgrade back before it tries again.
kill_tree() {
  local child
  for child in $(cat /proc/"$1"/task/*/children 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
  return 0
}

cleanup() {
  if [ "$interrupted" = 1 ] && [ -n "$bgpid" ]; then kill_tree "$bgpid"; fi
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  if [ "$screen" = 1 ]; then printf '\e[0m\e[?25h' >&2 2>/dev/null || true; fi
}

# ------------------------------------------------------------ the questions
#
# Asked on /dev/tty (fd 5) before anything is installed, in the same Plum &
# Gold with the ghost. Each answer can also come from a flag; the saved
# answers in /etc/josi/install.json are the defaults on a rerun. The real
# check of every answer is josi-ce-server-install's; these only catch typing
# mistakes early.

YES=0 TTY=0 styled=0 QL=0 QH=0 ERR='' CL='' MARK='>'
A_MODE='' A_LAN='' A_DOMAIN='' A_EMAIL='' A_URL='' A_PORT='' A_PC='' A_NOPC=0 A_BROWSER='' GIVEN=' '
S_MODE='' S_LAN='' S_DOMAIN='' S_EMAIL='' S_URL='' S_PORT='' S_PC='' S_BROWSER='' CUR_PORT='' LAN_IP='' SUDO_REAL=''
CLI_ARGS=()

usage() {
  cat >&2 <<'EOF'
Josi installer. Without options it asks its questions on the terminal.

  --yes, -y                        ask nothing (also JOSI_YES=1, or when there is no terminal)
  --from FOLDER                    install the package from this folder instead of downloading it
  --address-mode lan|domain|proxy  this network only / a public domain with HTTPS / my own proxy
  --lan-address HOST               lan: this server's address (default: detected)
  --domain NAME                    domain: the name whose DNS points here (Caddy uses 80 and 443)
  --email ADDRESS                  domain: email for certificate notices
  --public-url https://HOST        proxy: the address your reverse proxy serves
  --port N                         the browser port (default 8080)
  --pc-control-user USER           let Josi control this computer as USER
  --browser, --no-browser          with PC control: Josi's own browser (Chrome on a hidden screen, ~600 MB)
  --no-pc-control                  do not

Anything not given keeps the saved answer, or the default.
EOF
}

parse_args() {
  local name value
  while [ $# -gt 0 ]; do
    name=$1 value=''
    case $name in --*=*) value=${name#*=} name=${name%%=*} ;; esac
    case $name in
      --yes | -y) YES=1; shift; continue ;;
      --no-pc-control) A_NOPC=1 A_PC='' GIVEN+='pc '; CLI_ARGS+=(--no-pc-control); shift; continue ;;
      --browser) A_BROWSER=1 GIVEN+='browser '; CLI_ARGS+=(--browser); shift; continue ;;
      --no-browser) A_BROWSER=0 GIVEN+='browser '; CLI_ARGS+=(--no-browser); shift; continue ;;
      --help | -h) usage; exit 0 ;;
      # A folder that already holds the package (install.sh in an offline
      # folder passes its own); it is checked against the same SHA-256.
      --from)
        if [ -z "$value" ]; then [ $# -ge 2 ] || { printf 'Josi installer: --from needs a folder
' >&2; exit 2; }; value=$2; shift; fi
        FROM_DIR=$value; shift; continue ;;
      --address-mode | --lan-address | --domain | --email | --public-url | --port | --pc-control-user) ;;
      *) printf 'Josi installer: unknown option %s (try --help)\n' "${name:0:40}" >&2; exit 2 ;;
    esac
    if [ "$1" = "$name" ]; then
      [ $# -ge 2 ] || { printf 'Josi installer: %s needs a value\n' "$name" >&2; exit 2; }
      value=$2; shift
    fi
    shift
    CLI_ARGS+=("$name" "$value")
    case $name in
      --address-mode) A_MODE=$value GIVEN+='mode ' ;;
      --lan-address) A_LAN=$value ;;
      --domain) A_DOMAIN=$value ;;
      --email) A_EMAIL=$value ;;
      --public-url) A_URL=$value ;;
      --port) A_PORT=$value GIVEN+='port ' ;;
      --pc-control-user) A_PC=$value A_NOPC=0 GIVEN+='pc ' ;;
    esac
  done
  if [ "${JOSI_YES:-0}" = 1 ]; then YES=1; fi
  return 0
}

# The answers saved by the last install, read by root's own python3.
load_saved() {
  local f=/etc/josi/install.json out
  if [ -f /var/lib/josi/status.json ]; then
    CUR_PORT=$(sed -n 's/.*"publicPort": *\([0-9][0-9]*\).*/\1/p' /var/lib/josi/status.json 2>/dev/null || true)
  fi
  [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c %u "$f" 2>/dev/null)" = 0 ] || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  out=$(python3 -I - "$f" 2>/dev/null <<'PY'
import json, shlex, sys
value = json.load(open(sys.argv[1]))
for key, name in (('addressMode', 'S_MODE'), ('lanAddress', 'S_LAN'), ('domain', 'S_DOMAIN'), ('email', 'S_EMAIL'),
                  ('publicUrl', 'S_URL'), ('port', 'S_PORT'), ('pcControlUser', 'S_PC'), ('browser', 'S_BROWSER')):
    item = value.get(key)
    if isinstance(item, bool):
        item = int(item)
    print(name + '=' + shlex.quote('' if item is None else str(item)))
PY
  ) || return 0
  eval "$out"
  return 0
}

detect_lan() {
  local a=''
  a=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '!found { for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); found = 1; break } }') || a=''
  [ -n "$a" ] || a=$(hostname -I 2>/dev/null | awk '{ print $1 }') || a=''
  case $a in '' | 127.*) a=127.0.0.1 ;; esac
  LAN_IP=$a
  return 0
}

# 0 when another program listens on the port.
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ] && return 0
    return 1
  fi
  (exec 6<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

free_port_after() {
  local p=$1
  while [ "$p" -lt 65535 ]; do
    p=$((p + 1))
    if ! port_busy "$p"; then REPLY=$p; return 0; fi
  done
  REPLY=$1
  return 0
}

real_user() {
  local line uid
  [[ $1 =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || return 1
  line=$(getent passwd "$1" 2>/dev/null) || return 1
  uid=$(cut -d: -f3 <<< "$line")
  case $uid in '' | *[!0-9]*) return 1 ;; esac
  [ "$uid" -ge 1000 ] && [ "$uid" != 65534 ] || return 1
  case ${line##*:} in */nologin | */false) return 1 ;; esac
  return 0
}

valid_host() {
  [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] && [[ $1 != *..* ]]
}

valid_domain() {
  [[ $1 =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]]
}

valid_email() {
  [[ $1 =~ ^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$ ]]
}

# A graphical login on this machine: then the optional desktop helpers help.
has_desktop() {
  local s
  [ "$(systemctl get-default 2>/dev/null)" = graphical.target ] && return 0
  for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{ print $1 }'); do
    case $(loginctl show-session "$s" -p Type --value 2>/dev/null) in x11 | wayland) return 0 ;; esac
  done
  return 1
}

# The terminal, when there is one this process may read: under curl | bash
# stdin is the script. sudo-rs can run the script outside the terminal's
# foreground group, where reading would stop it; then nothing is asked.
# OUTER: the /dev/pts device of the nearest ancestor whose terminal is not $1,
# and OUTER_EXE: that ancestor's program (it made our terminal).
outer_tty() {
  local mine=$1 p=$PPID major minor
  local -a f
  OUTER='' OUTER_EXE=''
  while [ "${p:-0}" -gt 1 ]; do
    # Fields after "(comm)": state ppid pgrp session tty_nr ...
    read -r -a f <<< "$(sed 's/^.*) //' "/proc/$p/stat" 2>/dev/null)"
    [ "${#f[@]}" -ge 5 ] || return 0
    if [ "${f[4]}" != 0 ] && [ "${f[4]}" != "$mine" ]; then
      major=$(( (f[4] >> 8) & 0xfff )); minor=$(( (f[4] & 0xff) | ((f[4] >> 12) & 0xfff00) ))
      if [ "$major" -ge 136 ] && [ "$major" -le 143 ] && [ -c "/dev/pts/$(( (major - 136) * 256 + minor ))" ]; then
        OUTER=/dev/pts/$(( (major - 136) * 256 + minor ))
      fi
      OUTER_EXE=$(readlink "/proc/$p/exe" 2>/dev/null || true)
      return 0
    fi
    p=${f[1]}
  done
  return 0
}

# sudo-rs (Ubuntu 25.10 and later) relays the keyboard into the terminal it
# made for us, whatever stdin is. Reading the outer terminal as well would
# split the keystrokes between the two readers: letters and Enter went
# missing (https://ce.heyjosi.com arrived as https://e.hejs.cm). There the
# answers are read where it sends them, our own terminal, after becoming
# its foreground group: SIGTTOU is ignored, so that is allowed.
relays_keyboard() {
  case $OUTER_EXE in /*) ;; *) return 1 ;; esac
  timeout -s KILL 2 "$OUTER_EXE" --version </dev/null 2>&1 | grep -qi 'sudo-rs'
}

take_foreground() {
  local -a now
  if command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e 'exit(POSIX::tcsetpgrp(5, getpgrp()) ? 0 : 1)' 2>/dev/null || return 1
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os; os.tcsetpgrp(5, os.getpgrp())' 2>/dev/null || return 1
  else
    return 1
  fi
  read -r -a now <<< "$(sed 's/^.*) //' /proc/$$/stat 2>/dev/null)"
  [ "${#now[@]}" -ge 6 ] && [ "${now[2]}" = "${now[5]}" ]
}

open_tty() {
  local -a st
  [ "$YES" = 0 ] || return 0
  { exec 5<>/dev/tty; } 2>/dev/null || return 0
  trap '' TTOU TTIN
  # Fields after the "(comm)" one: state ppid pgrp session tty tpgid.
  # With the script piped in (curl | sudo bash), use_pty runs it in the
  # background of a terminal of its own. Classic sudo, unlike sudo-rs, sends that terminal
  # no keyboard, so the questions go to the terminal the person is typing in:
  # the first ancestor process on a different terminal. That is not our
  # controlling terminal, so reading it is allowed from here. For sudo-rs
  # see relays_keyboard.
  read -r -a st <<< "$(sed 's/^.*) //' /proc/$$/stat 2>/dev/null)"
  if [ "${#st[@]}" -ge 6 ] && [ "${st[2]}" != "${st[5]}" ]; then
    outer_tty "${st[4]}"
    if relays_keyboard && take_foreground; then st[5]=${st[2]}
    elif [ -n "$OUTER" ] && { exec 5<>"$OUTER"; } 2>/dev/null; then st[5]=${st[2]}; fi
  fi
  if [ "${#st[@]}" -lt 6 ] || [ "${st[2]}" != "${st[5]}" ]; then
    exec 5>&-
    printf 'Josi installer: this terminal cannot be read here; using the saved or default answers (see --help).\n' >&3
    return 0
  fi
  TTY=1
  if [ "$can_screen" = 1 ]; then styled=1 CL=$'\r\e[2K'; fi
  if [ "$utf8" = 1 ]; then MARK='›'; fi
  return 0
}

q() { printf '%s  %s\n' "$CL" "$1" >&5; QL=$((QL + 1)); return 0; }

q_clear() {
  if [ "$styled" = 1 ] && [ "$QL" -gt 0 ]; then printf '\e[%dA\r\e[J' "$QL" >&5; fi
  QL=0
  if [ -n "$ERR" ]; then q "${RED}${NO} ${ERR}${RST}"; q ''; ERR=''; fi
  return 0
}

q_header() {
  local i
  local -a t=('' '' '' '' "${BOLD}${GOLD}Josi${RST}  ${LILAC}${VERSION}${RST}"
    "${LILAC}A few questions, then Josi installs itself.${RST}"
    "${DIM}Enter keeps the answer shown; Ctrl-C stops.${RST}" '' '' '' '')
  QH=0
  if [ "$styled" = 1 ] && [ "$GL" -gt 0 ]; then
    printf '\n' >&5
    for ((i = 0; i < GL; i++)); do printf '\r\e[2K  %s    %s\n' "${GH[0,$i]}" "${t[i]}" >&5; done
    QH=$((GL + 1))
  else
    printf '\n%s  %s\n' "$CL" "${BOLD}${GOLD}Josi${RST} ${LILAC}${VERSION}${RST}  a few questions, then Josi installs itself." >&5
    QH=2
  fi
  printf '%s\n' "$CL" >&5
  QH=$((QH + 1))
  return 0
}

# ask <question> <shown answer>: one line from the terminal into REPLY,
# with the answer already typed in so Enter keeps it or it can be edited
# (readline; its echo goes to the terminal, never to stdout).
# A one-key choice (third argument "choice") shows its default in brackets
# instead, so typing 2 over a shown 1 does not read as 12.
ask() {
  local prompt shown=$2 hint=''
  if [ "${3:-}" = choice ]; then shown='' hint="[$2] "; fi
  if [ "$styled" = 1 ]; then
    prompt=$'  \001'"$GOLD"$'\002'"$MARK"$'\001'"$RST$BOLD"$'\002'" $1 "$'\001'"$RST$DIM"$'\002'"$hint"$'\001'"$RST"$'\002'
  else
    prompt="  $MARK $1 $hint"
  fi
  if ! IFS= read -e -r -i "$shown" -p "$prompt" REPLY <&5 >&5 2>&5; then
    printf '\n' >&5
    fail 'no answer was given; nothing was installed'
  fi
  QL=$((QL + 1))
  REPLY=${REPLY#"${REPLY%%[![:space:]]*}"}
  REPLY=${REPLY%"${REPLY##*[![:space:]]}"}
  return 0
}

ask_lan() {
  ask "This server's address on your network:" "$A_LAN"
  REPLY=${REPLY:-$A_LAN}
  if valid_host "$REPLY"; then A_LAN=$REPLY; return 0; fi
  ERR="That is not an IP address or a host name: ${REPLY:0:60}"
  return 1
}

ask_domain() {
  local d busy=''
  ask 'Domain name (its DNS points at this server):' "$A_DOMAIN"
  d=${REPLY,,}; d=${d%.}
  if ! valid_domain "$d"; then ERR="That is not a domain name: ${REPLY:0:60}"; return 1; fi
  A_DOMAIN=$d
  if [ "$S_MODE" != domain ]; then
    if port_busy 80; then busy=80; fi
    if port_busy 443; then busy="${busy:+$busy and }443"; fi
    if [ -n "$busy" ]; then
      ERR="Port $busy is taken by another program; Josi's Caddy needs 80 and 443. Choose 3 to use your own proxy."
      return 1
    fi
  fi
  ask 'Email for certificate notices (empty for none):' "$A_EMAIL"
  if [ -n "$REPLY" ] && ! valid_email "$REPLY"; then ERR="That is not an email address: ${REPLY:0:60}"; return 1; fi
  A_EMAIL=$REPLY
  return 0
}

ask_proxy() {
  ask 'The https address your proxy serves:' "${A_URL:-https://}"
  if [[ $REPLY =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$ ]]; then
    A_URL=${REPLY%/}
    return 0
  fi
  ERR="Type it as https://josi.example.com, with no path: ${REPLY:0:60}"
  return 1
}

ask_mode() {
  local n
  case $GIVEN in *' mode '*) return 0 ;; esac
  while :; do
    q_clear
    q "${BOLD}How will people reach Josi?${RST}"
    q ''
    q "  ${GOLD}1${RST}  This network only           ${DIM}http://${A_LAN}:${A_PORT}${RST}"
    q "  ${GOLD}2${RST}  A public domain             ${DIM}HTTPS from Josi's own Caddy, on ports 80 and 443${RST}"
    q "  ${GOLD}3${RST}  Behind my own reverse proxy ${DIM}it already serves HTTPS and forwards to Josi${RST}"
    q ''
    case $A_MODE in domain) n=2 ;; proxy) n=3 ;; *) n=1 ;; esac
    ask 'Choose 1, 2 or 3:' "$n" choice
    case ${REPLY:-$n} in
      1) A_MODE=lan; if ask_lan; then return 0; fi ;;
      2) A_MODE=domain; if ask_domain; then return 0; fi ;;
      3) A_MODE=proxy; if ask_proxy; then return 0; fi ;;
      *) ERR='Type 1, 2 or 3.' ;;
    esac
  done
}

ask_port() {
  local p
  case $GIVEN in *' port '*) return 0 ;; esac
  if [ "$A_PORT" != "$CUR_PORT" ] && port_busy "$A_PORT"; then free_port_after "$A_PORT"; A_PORT=$REPLY; fi
  while :; do
    q_clear
    q "${BOLD}Which port should Josi answer on?${RST}"
    case $A_MODE in
      lan) q "${DIM}People open http://${A_LAN}:<port>.${RST}" ;;
      domain) q "${DIM}https://${A_DOMAIN} uses 80 and 443; this port serves this network over plain HTTP.${RST}" ;;
      *) q "${DIM}Point your proxy at http://${LAN_IP}:<port>.${RST}" ;;
    esac
    q ''
    ask 'Port:' "$A_PORT"
    p=${REPLY:-$A_PORT}
    if ! [[ $p =~ ^[0-9]{4,5}$ ]] || [ "$((10#$p))" -lt 1024 ] || [ "$((10#$p))" -gt 65535 ]; then
      ERR='Choose a port from 1024 to 65535.'
      continue
    fi
    p=$((10#$p))
    if [ "$p" != "$CUR_PORT" ] && port_busy "$p"; then
      free_port_after "$p"; A_PORT=$REPLY
      ERR="Port $p is taken by another program; $A_PORT is free."
      continue
    fi
    A_PORT=$p
    return 0
  done
}

ask_pc() {
  local d
  case $GIVEN in *' pc '*) return 0 ;; esac
  while :; do
    q_clear
    q "${BOLD}Let Josi control this computer?${RST}"
    q "${DIM}Josi can then run commands, work with files and start programs here,${RST}"
    q "${DIM}as a Linux user you choose and with only that user's permissions.${RST}"
    q ''
    if [ "$A_NOPC" = 1 ] || [ -z "$A_PC" ]; then d=n; else d=y; fi
    ask 'Allow it? (y/n):' "$d" choice
    REPLY=${REPLY:-$d}
    case ${REPLY,,} in
      n | no) A_NOPC=1 A_PC=''; return 0 ;;
      y | yes) ;;
      *) ERR='Type y or n.'; continue ;;
    esac
    ask 'Which Linux user should Josi act as?' "${A_PC:-$SUDO_REAL}"
    if real_user "$REPLY"; then A_PC=$REPLY A_NOPC=0; return 0; fi
    ERR="${REPLY:0:40} is not a normal login account on this machine."
    A_PC='' A_NOPC=0
  done
}

ask_browser() {
  local d
  case $GIVEN in *' browser '*) return 0 ;; esac
  if [ "$A_NOPC" = 1 ] || [ -z "$A_PC" ]; then return 0; fi
  while :; do
    q_clear
    q "${BOLD}Give Josi her own browser?${RST}"
    q "${DIM}A hidden screen with Chrome she can use for web pages, about 600 MB.${RST}"
    q ''
    if [ "$A_BROWSER" = 0 ]; then d=n; else d=y; fi
    ask 'Add it? (y/n):' "$d" choice
    REPLY=${REPLY:-$d}
    case ${REPLY,,} in
      y | yes) A_BROWSER=1; return 0 ;;
      n | no) A_BROWSER=0; return 0 ;;
      *) ERR='Type y or n.' ;;
    esac
  done
}

# Josi's own browser: Chrome for Testing (the launcher downloads it) on Xvfb.
# Every library it needs, picking whichever name this release has (Debian 13
# and Ubuntu 24.04+ renamed several to ...t64). One by one if the batch fails.
browser_packages() {
  local item name pick
  REPLY=''
  for item in xvfb xauth unzip openbox xdotool wmctrl imagemagick fonts-liberation fonts-noto-color-emoji \
      libnss3 libgbm1 libxkbcommon0 libxss1 libdrm2 libxcomposite1 libxdamage1 libxrandr2 libxshmfence1 \
      libpango-1.0-0 libcairo2 ca-certificates libasound2t64/libasound2 libgtk-3-0t64/libgtk-3-0 \
      libcups2t64/libcups2 libatk-bridge2.0-0t64/libatk-bridge2.0-0 libatk1.0-0t64/libatk1.0-0 \
      libglib2.0-0t64/libglib2.0-0; do
    pick=''
    for name in ${item//\// }; do
      case $(apt-cache policy "$name" 2>/dev/null | awk '/Candidate:/ { print $2 }') in
        '' | '(none)') ;;
        *) pick=$name; break ;;
      esac
    done
    if [ -n "$pick" ]; then REPLY+=" $pick"; else printf 'No package for %s\n' "$item" >&3; fi
  done
  return 0
}

# Ubuntu 23.10 and later (and its forks) refuse the unprivileged user
# namespaces Chrome's sandbox needs, unless an AppArmor profile allows them
# for that program. This one names only Josi's own Chrome, so its sandbox stays
# on; elsewhere nothing is written.
chrome_userns() {
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] || return 0
  command -v apparmor_parser >/dev/null 2>&1 && [ -d /etc/apparmor.d ] || return 0
  cat > /etc/apparmor.d/josi-chrome <<'PROFILE'
# Written by the Josi installer: lets Josi's own Chrome use its sandbox.
abi <abi/4.0>,
include <tunables/global>

profile josi-chrome /var/lib/josi-pc/browser/chrome-*/chrome-linux64/chrome flags=(unconfined) {
  userns,
  include if exists <local/josi-chrome>
}
PROFILE
  if apparmor_parser -r /etc/apparmor.d/josi-chrome >&3 2>&1; then
    # A Chrome that started before the profile runs without its sandbox: restart it.
    systemctl try-restart josi-browser.service >&3 2>&1 || true
  else
    printf 'The AppArmor profile for the Josi browser did not load; Chrome runs without its sandbox\n' >&3
  fi
  return 0
}

install_browser_packages() {
  local name names
  browser_packages
  names=$REPLY  # the screen's drawing reuses REPLY
  # shellcheck disable=SC2086
  run apt_get install -y -q --no-install-recommends $names && { chrome_userns; return 0; }
  chrome_userns
  for name in $names; do
    run apt_get install -y -q --no-install-recommends "$name" || printf 'Browser package %s was not installed\n' "$name" >&3
  done
  return 0
}

summary() {
  local address how pc
  q_clear
  case $A_MODE in
    lan) address="http://$A_LAN:$A_PORT" how='this network only' ;;
    domain) address="https://$A_DOMAIN" how="HTTPS from Josi's Caddy; on this network also http://$LAN_IP:$A_PORT" ;;
    *) address=$A_URL how="your proxy forwards to http://$LAN_IP:$A_PORT" ;;
  esac
  if [ "$A_NOPC" = 1 ] || [ -z "$A_PC" ]; then pc=no; else pc="yes, as $A_PC"; fi
  q "${BOLD}Josi will be set up like this:${RST}"
  q ''
  q "  ${LILAC}Address${RST}       ${BOLD}${GOLD}${address}${RST}"
  q "                ${DIM}${how}${RST}"
  q "  ${LILAC}Port${RST}          $A_PORT"
  if [ "$A_MODE" = domain ] && [ -n "$A_EMAIL" ]; then q "  ${LILAC}Certificates${RST}  notices to $A_EMAIL"; fi
  q "  ${LILAC}PC control${RST}    $pc"
  if [ "$pc" != no ]; then
    if [ "$A_BROWSER" = 1 ]; then q "  ${LILAC}Own browser${RST}   yes, Chrome on a hidden screen"; else q "  ${LILAC}Own browser${RST}   no"; fi
  fi
  q ''
  ask 'Install Josi now? (y/n):' y choice
  REPLY=${REPLY:-y}
  case ${REPLY,,} in y | yes) return 0 ;; esac
  GIVEN=' '  # n: every question again, with these answers shown
  return 1
}

questions() {
  # Defaults: a flag, then the saved answer, then this machine.
  if [ -n "${SUDO_USER:-}" ] && real_user "$SUDO_USER"; then SUDO_REAL=$SUDO_USER; fi
  [ -n "$A_MODE" ] || A_MODE=${S_MODE:-lan}
  [ -n "$A_LAN" ] || A_LAN=${S_LAN:-$LAN_IP}
  [ -n "$A_DOMAIN" ] || A_DOMAIN=$S_DOMAIN
  [ -n "$A_EMAIL" ] || A_EMAIL=$S_EMAIL
  [ -n "$A_URL" ] || A_URL=$S_URL
  [ -n "$A_PORT" ] || A_PORT=${S_PORT:-${CUR_PORT:-8080}}
  # PC control is on by default on a first install, as the person installing
  # (as on Windows); a saved "no" stays no, and a root shell has no such user.
  case $GIVEN in *' pc '*) ;; *)
    if [ -n "$S_PC" ]; then A_PC=$S_PC
    elif [ -z "$S_MODE" ] && [ -n "${SUDO_REAL:-}" ]; then A_PC=$SUDO_REAL
    else A_NOPC=1; fi ;;
  esac
  # The browser defaults to yes with PC control, unless it was saved as no.
  [ -n "$A_BROWSER" ] || { [ "$S_BROWSER" = 0 ] && [ -n "$S_PC" ] && A_BROWSER=0; } || A_BROWSER=1
  if [ "$TTY" != 1 ]; then
    # Nothing asked: the flags go to the install command, plus PC control by
    # default for the person installing, on a first install.
    case $GIVEN in *' pc '*) ;; *) if [ "$A_NOPC" != 1 ] && [ -n "$A_PC" ] && [ -z "$S_PC" ]; then CLI_ARGS+=(--pc-control-user "$A_PC" --browser); fi ;; esac
    return 0
  fi
  q_header
  while :; do
    ask_mode
    ask_port
    ask_pc
    ask_browser
    if summary; then break; fi
  done
  if [ "$styled" = 1 ]; then printf '\e[%dA\r\e[J' $((QL + QH)) >&5; fi
  CLI_ARGS=(--address-mode "$A_MODE" --port "$A_PORT")
  case $A_MODE in
    lan) CLI_ARGS+=(--lan-address "$A_LAN") ;;
    domain) CLI_ARGS+=(--domain "$A_DOMAIN"); if [ -n "$A_EMAIL" ]; then CLI_ARGS+=(--email "$A_EMAIL"); fi ;;
    *) CLI_ARGS+=(--public-url "$A_URL") ;;
  esac
  if [ "$A_NOPC" = 1 ] || [ -z "$A_PC" ]; then
    CLI_ARGS+=(--no-pc-control)
  elif [ "$A_BROWSER" = 1 ]; then
    CLI_ARGS+=(--pc-control-user "$A_PC" --browser)
  else
    CLI_ARGS+=(--pc-control-user "$A_PC" --no-browser)
  fi
  return 0
}

# ------------------------------------------------------------- the commands

apt_get() { apt-get -o "$APT_LOCK" -o APT::Status-Fd=4 "$@" 4>"$work/status"; }
download() {
  if [ -n "$FROM_DIR" ]; then cp -- "$FROM_DIR/$package" "$work/$package"; return; fi
  curl --fail --location --silent --show-error --proto "$proto" --retry 3 \
    --output "$work/$package" "$BASE_URL/$package"
}
checksum() { sha256sum "$work/$package" > "$work/sum"; }
start_josi() { /usr/bin/josi-ce-server-install 2>&3 > "$work/url" ${CLI_ARGS[@]+"${CLI_ARGS[@]}"}; }

main() {
  local line missing actual rest port helpers=''
  parse_args "$@"
  [ "$(uname -s)" = Linux ] || fail 'Linux is required'
  [ "$(id -u)" = 0 ] || fail 'run it as root: curl -fsSL <address>/linux | sudo bash, or from a root shell: wget -qO- <address>/linux | bash'
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || fail 'systemd is required'
  if [ -d /var/lib/josi-ce-server ] && [ ! -e /var/lib/josi/installation.json ]; then
    fail "an earlier Josi CE Server from before the rename is in /var/lib/josi-ce-server, with services and
  accounts of the same names. Remove it first (this deletes its data; back up its chats in its
  Administration > Backups first), as root:
    systemctl disable --now josi-ce-database josi-ce-voice josi-ce-voice-control josi-ce-web josi-ce-worker josi-ce-proxy
    rm -f /etc/systemd/system/josi-ce-*.service; systemctl daemon-reload
    for a in database voice control web worker proxy; do userdel josi-ce-\$a; groupdel josi-ce-\$a; done
    groupdel josi-ce-app; groupdel josi-ce-voice-shared; rm -rf /var/lib/josi-ce-server
  then run this command again."
  fi

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
  trap 'interrupted=1; exit 130' INT TERM
  # A dropped SSH session must not stop dpkg or the lifecycle half-way: the
  # hangup is ignored here and, inherited, by everything this starts.
  trap '' HUP

  init_screen
  open_tty
  load_saved
  detect_lan
  questions
  printf 'Answers: %s\n' "${CLI_ARGS[*]-saved or default}" >&3
  start_screen

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
  # PC control on a machine with a graphical login: the optional desktop
  # helpers (typing, windows, screenshots). Never required.
  if [ "$A_NOPC" != 1 ] && [ -n "$A_PC" ] && has_desktop; then helpers='xdotool wmctrl scrot'; fi
  if [ "$family" = arch ]; then
    missing=$(pacman -T curl python rsync acl iproute2 || true)
    if [ -n "$missing" ]; then
      # shellcheck disable=SC2086
      run pacman -Sy --needed --noconfirm $missing || fail 'pacman could not install the dependencies'
    fi
    if [ -n "$helpers" ]; then
      # shellcheck disable=SC2086
      run pacman -S --needed --noconfirm $helpers || printf 'Desktop helpers were not installed\n' >&3
    fi
  else
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
    # Finish what an interrupted apt or dpkg (Ctrl-C, a dropped session) left
    # half-configured; until then apt refuses to install anything.
    run dpkg --configure -a || printf 'dpkg --configure -a did not finish\n' >&3
    run apt-get -o "$APT_LOCK" update -q || fail 'apt-get update failed'
    run apt_get install -y -q ca-certificates curl python3 rsync acl iproute2 || fail 'apt could not install the dependencies'
    if [ -n "$helpers" ]; then
      # shellcheck disable=SC2086
      run apt_get install -y -q --no-install-recommends $helpers || printf 'Desktop helpers were not installed\n' >&3
    fi
    if [ "$A_NOPC" != 1 ] && [ -n "$A_PC" ] && [ "$A_BROWSER" = 1 ]; then install_browser_packages; fi
  fi
  finish

  begin 2
  proto='=https'
  case "$BASE_URL" in http://*) proto='=http,https' ;; esac
  if [ -n "$FROM_DIR" ]; then
    [ -f "$FROM_DIR/$package" ] || fail "$package is not in $FROM_DIR"
    size=0
  else
    size=$(curl -fsIL --proto "$proto" --max-time 20 "$BASE_URL/$package" 2>/dev/null | tr -d '\r' \
      | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }') || size=0
  fi
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
      https://*)
        # Until the domain's DNS and certificate are in place, or the proxy
        # forwards, the same link works on this network over plain HTTP.
        port=$(sed -n 's/.*"publicPort": *\([0-9][0-9]*\).*/\1/p' /var/lib/josi/status.json 2>/dev/null || true)
        rest=${url#https://}; rest=${rest#*/}
        printf '\n  %sIf that address does not open yet, on this network use http://%s:%s/%s%s\n' \
          "$DIM" "$LAN_IP" "${port:-8080}" "$rest" "$RST" >&2 ;;
    esac
    case $url in
      *'#handoff='*) printf '\n  %sThe link works once, for 10 minutes. Run the same command again for a new one.%s\n\n' "$DIM" "$RST" >&2 ;;
      *) printf '\n' >&2 ;;
    esac
  fi
}

main "$@"
