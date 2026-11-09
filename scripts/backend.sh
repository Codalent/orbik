#!/bin/sh
# Safely switch only the backend PM2 process between development and production.
set -eu

if [ "$#" -ne 1 ] || { [ "$1" != "dev" ] && [ "$1" != "prod" ]; }; then
  printf '%s\n' "Usage: $0 dev|prod" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
mode=$1
requested="orbik-backend-$mode"
if [ "$mode" = "dev" ]; then opposite="orbik-backend-prod"; else opposite="orbik-backend-dev"; fi

command -v pm2 >/dev/null 2>&1 || { printf '%s\n' "PM2 is required." >&2; exit 69; }
command -v lsof >/dev/null 2>&1 || { printf '%s\n' "lsof is required for port ownership validation." >&2; exit 69; }
if [ ! -f "$project_root/backend/.env" ]; then
  printf '%s\n' "backend/.env is missing; no process was changed." >&2
  exit 66
fi

listener_pids=$(lsof -nP -t -iTCP:4100 -sTCP:LISTEN 2>/dev/null || true)
requested_pid=$(pm2 pid "$requested" 2>/dev/null || true)
opposite_pid=$(pm2 pid "$opposite" 2>/dev/null || true)
for listener_pid in $listener_pids; do
  if [ "$listener_pid" != "$requested_pid" ] && [ "$listener_pid" != "$opposite_pid" ]; then
    printf '%s\n' "Port 4100 is occupied by unrelated PID $listener_pid; no process was changed." >&2
    exit 73
  fi
done

pm2 delete "$opposite" >/dev/null 2>&1 || true
pm2 startOrReload "$project_root/ecosystem.config.cjs" --only "$requested" --update-env
