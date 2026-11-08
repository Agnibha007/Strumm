#!/bin/sh
set -eu

API_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$API_DIR"

export HOKAS_PROFILE=1
export PYTHONUNBUFFERED=1

exec python -m uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-3000}" \
    --workers 1 \
    --limit-concurrency 8 \
    --timeout-keep-alive 10
