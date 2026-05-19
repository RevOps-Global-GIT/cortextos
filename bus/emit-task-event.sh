#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$(cd "$SCRIPT_DIR/.." && pwd)/dist/cli.js"
exec node "$CLI" bus emit-task-event "$@"
