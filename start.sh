#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

npm run dev:api &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 2
npm run dev:ui
