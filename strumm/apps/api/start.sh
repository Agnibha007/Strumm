#!/bin/bash
set -euo pipefail

export API_URL="http://127.0.0.1:9000/"
export API_PORT="9000"
export API_LISTEN_ADDRESS="127.0.0.1"
export API_AUTH_REQUIRED="0"

(cd /opt/cobalt && node src/cobalt) &
COBALT_PID=$!

for attempt in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:9000/ >/dev/null; then
        break
    fi
    if ! kill -0 "$COBALT_PID" 2>/dev/null; then
        wait "$COBALT_PID" || true
        echo "Cobalt exited before becoming ready" >&2
        exit 1
    fi
    sleep 1
done

if ! curl -fsS http://127.0.0.1:9000/ >/dev/null; then
    echo "Cobalt did not become ready within 30 seconds" >&2
    kill "$COBALT_PID" 2>/dev/null || true
    exit 1
fi

echo "Cobalt API is ready on 127.0.0.1:9000"

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
