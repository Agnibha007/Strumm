#!/bin/bash
set -euo pipefail

export API_URL="http://127.0.0.1:9000/"
export API_PORT="9000"
export API_LISTEN_ADDRESS="127.0.0.1"
export API_AUTH_REQUIRED="0"

(cd /opt/cobalt && node src/cobalt) &
COBALT_PID=$!

uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-7860}" \
    --workers 1 \
    --limit-concurrency 64 \
    --timeout-keep-alive 15 &
API_PID=$!

terminate() {
    kill "$COBALT_PID" "$API_PID" 2>/dev/null || true
    wait "$COBALT_PID" "$API_PID" 2>/dev/null || true
}
trap terminate TERM INT

set +e
wait -n "$COBALT_PID" "$API_PID"
STATUS=$?
set -e
terminate
exit "$STATUS"
