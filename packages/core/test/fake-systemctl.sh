#!/bin/bash
# Test amaçlı minimal systemctl taklidi (sadece OeziDev testleri için).
STATE=/tmp/fake-systemd; mkdir -p $STATE
UNITDIR=/etc/systemd/system
unitfile() { echo "$UNITDIR/$1"; }
prop() { grep -m1 "^$2=" "$(unitfile $1)" | cut -d= -f2-; }
alive() { local p; p=$(cat $STATE/$1.pid 2>/dev/null) && kill -0 "$p" 2>/dev/null && [ "$(awk '{print $3}' /proc/$p/stat 2>/dev/null)" != Z ]; }
start_one() {
  local u=$1; alive $u && return 0
  local exec wd log; exec=$(prop $u ExecStart); wd=$(prop $u WorkingDirectory); log=$(prop $u StandardOutput); log=${log#append:}
  wd=${wd#\"}; wd=${wd%\"}
  exec=${exec//\$\$/\$}; exec=${exec//%%/%}
  (cd "$wd" || exit 1; eval "set -- $exec"; nohup setsid "$@" >> "$log" 2>&1 < /dev/null & echo $! > $STATE/$u.pid)
  sleep 0.2; date +%s > $STATE/$u.started
}
stop_one() {
  local u=$1 p; p=$(cat $STATE/$u.pid 2>/dev/null) || return 0
  kill -TERM -- -$p 2>/dev/null || kill -TERM $p 2>/dev/null
  for i in $(seq 1 50); do kill -0 $p 2>/dev/null || break; sleep 0.1; done
  kill -KILL -- -$p 2>/dev/null; rm -f $STATE/$u.pid
  # PartOf bağımlılarını da durdur
  for f in $UNITDIR/*.service; do grep -q "^PartOf=$u$" "$f" 2>/dev/null && stop_one "$(basename $f)"; done
}
cmd=$1; shift
case "$cmd" in
  daemon-reload|reset-failed|enable|disable) exit 0 ;;
  start) for u in "$@"; do start_one $u; done ;;
  stop) for u in "$@"; do stop_one $u; done ;;
  restart) for u in "$@"; do stop_one $u; start_one $u; done ;;
  show)
    u=$1
    if [ ! -f "$(unitfile $u)" ]; then echo LoadState=not-found; echo ActiveState=inactive; echo SubState=dead; echo MainPID=0; echo NRestarts=0; exit 0; fi
    echo LoadState=loaded
    if alive $u; then echo ActiveState=active; echo SubState=running; echo MainPID=$(cat $STATE/$u.pid); echo ActiveEnterTimestamp=@$(cat $STATE/$u.started)
    else echo ActiveState=inactive; echo SubState=dead; echo MainPID=0; fi
    echo NRestarts=0 ;;
  *) echo "fake systemctl: $cmd desteklenmiyor" >&2; exit 1 ;;
esac
