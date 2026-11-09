#!/bin/sh
# Safely switch the agent worker and scheduler PM2 processes between development and production.
#
# Unlike the frontend and backend helpers there is no port-ownership check: neither process binds
# a port, so there is no listener another process could be holding.
set -eu

if [ "$#" -ne 1 ] || { [ "$1" != "dev" ] && [ "$1" != "prod" ]; }; then
  printf '%s\n' "Usage: $0 dev|prod" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
mode=$1
if [ "$mode" = "dev" ]; then opposite_mode="prod"; else opposite_mode="dev"; fi

command -v pm2 >/dev/null 2>&1 || { printf '%s\n' "PM2 is required." >&2; exit 69; }
if [ ! -f "$project_root/agents/.env" ]; then
  printf '%s\n' "agents/.env is missing; no process was changed." >&2
  exit 66
fi

# The worker and the scheduler are switched together: a scheduler queueing work that no worker in
# the same mode will execute is a configuration that looks running but does nothing.
for process_name in worker scheduler; do
  pm2 delete "orbik-$process_name-$opposite_mode" >/dev/null 2>&1 || true
done
pm2 startOrReload "$project_root/ecosystem.config.cjs" \
  --only "orbik-worker-$mode,orbik-scheduler-$mode" --update-env
