#!/bin/sh
# Start or restart every Orbik PM2 process in one mode: frontend, backend, agents worker and
# scheduler. Running it again in the same mode restarts all four; running it in the other mode
# switches all four over.
#
# Every check, and the production build, happens before any process is touched, so a missing env
# file, a foreign listener or a failed compile leaves what is running exactly as it was.
set -eu

if [ "$#" -ne 1 ] || { [ "$1" != "dev" ] && [ "$1" != "prod" ]; }; then
  printf '%s\n' "Usage: $0 dev|prod" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
mode=$1
if [ "$mode" = "dev" ]; then opposite_mode="prod"; else opposite_mode="dev"; fi
processes="frontend backend worker scheduler"

command -v pm2 >/dev/null 2>&1 || { printf '%s\n' "PM2 is required." >&2; exit 69; }
command -v lsof >/dev/null 2>&1 || { printf '%s\n' "lsof is required for port ownership validation." >&2; exit 69; }
for env_file in backend/.env agents/.env; do
  if [ ! -f "$project_root/$env_file" ]; then
    printf '%s\n' "$env_file is missing; no process was changed." >&2
    exit 66
  fi
done

listener_pids() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

# A port held by anything other than our own process, in either mode, is somebody else's.
check_port() {
  requested_pid=$(pm2 pid "orbik-$1-$mode" 2>/dev/null || true)
  opposite_pid=$(pm2 pid "orbik-$1-$opposite_mode" 2>/dev/null || true)
  for listener_pid in $(listener_pids "$2"); do
    if [ "$listener_pid" != "$requested_pid" ] && [ "$listener_pid" != "$opposite_pid" ]; then
      printf '%s\n' "Port $2 is occupied by unrelated PID $listener_pid; no process was changed." >&2
      exit 73
    fi
  done
}
check_port frontend 3100
check_port backend 4100

# MongoDB and Qdrant are not started from here: they are system services that are always on.
# Qdrant being down is survivable (indexing and search report INDEX_UNAVAILABLE), so only warn.
[ -n "$(listener_pids 27017)" ] || printf '%s\n' "Warning: nothing is listening on 27017 (MongoDB)." >&2
[ -n "$(listener_pids 6333)" ] || printf '%s\n' "Warning: nothing is listening on 6333 (Qdrant); try: systemctl restart qdrant" >&2

# Production serves compiled output, so build from current source before reloading.
if [ "$mode" = "prod" ]; then
  command -v corepack >/dev/null 2>&1 || { printf '%s\n' "corepack is required to build the frontend." >&2; exit 69; }
  printf '%s\n' "Building frontend production bundle..."
  if ! corepack pnpm --dir "$project_root/frontend" run build; then
    printf '%s\n' "Frontend build failed; no process was changed." >&2
    exit 65
  fi
  if [ ! -f "$project_root/frontend/.next/BUILD_ID" ]; then
    printf '%s\n' "Frontend build produced no BUILD_ID; no process was changed." >&2
    exit 65
  fi
fi

only=""
for process_name in $processes; do
  pm2 delete "orbik-$process_name-$opposite_mode" >/dev/null 2>&1 || true
  only="$only${only:+,}orbik-$process_name-$mode"
done
pm2 startOrReload "$project_root/ecosystem.config.cjs" --only "$only" --update-env

# PM2 reports "online" as soon as a process is spawned; wait for the two listeners to be sure.
wait_for_port() {
  attempts=0
  while [ -z "$(listener_pids "$2")" ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      printf '%s\n' "$1 is not listening on $2 after 60s; see: pm2 logs orbik-$1-$mode" >&2
      return 1
    fi
    sleep 1
  done
  printf '%s\n' "$1 is listening on 127.0.0.1:$2"
}
failed=0
wait_for_port frontend 3100 || failed=1
wait_for_port backend 4100 || failed=1
for process_name in worker scheduler; do
  process_pid=$(pm2 pid "orbik-$process_name-$mode" 2>/dev/null || true)
  if [ -z "$process_pid" ] || [ "$process_pid" = "0" ]; then
    printf '%s\n' "$process_name is not running; see: pm2 logs orbik-$process_name-$mode" >&2
    failed=1
  else
    printf '%s\n' "$process_name is running (PID $process_pid)"
  fi
done
[ "$failed" -eq 0 ] || exit 70
printf '%s\n' "Orbik is up in $mode mode."
