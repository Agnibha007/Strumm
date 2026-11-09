#!/bin/bash
set -euo pipefail

exec uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-7860}" \
    --workers 1 \
    --limit-concurrency 64 \
    --timeout-keep-alive 15
