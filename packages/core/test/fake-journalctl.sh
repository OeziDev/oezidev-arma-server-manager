#!/bin/bash
# Test amaçlı minimal journalctl taklidi: -u UNIT -f [-n N | --since @T]
STATE=/tmp/fake-systemd; unit=""; n=10
while [ $# -gt 0 ]; do case "$1" in -u) unit=$2; shift ;; -n) n=$2; shift ;; --since) n=+1; shift ;; esac; shift; done
touch "$STATE/$unit.log"
exec tail -n "$n" -F "$STATE/$unit.log"
