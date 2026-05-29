#!/usr/bin/env bash
# Backward-compatibility shim. Older installs registered stop.sh directly;
# forward to the generic dispatcher so they keep working.
set -u
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$script_dir/hook.sh" on_stop
