#!/usr/bin/env bash
set -euo pipefail

source_dir="$1"
manifest_hash="$(sha256sum "$source_dir/deployment-manifest.json" | cut -c1-16)"
release="$HOME/.local/share/miaoshou-auto/releases/$manifest_hash"
if [[ ! -f "$release/.install-complete" ]]; then
    printf '%s\n' 'Client installation is incomplete. Run run-client.cmd again.' >&2
    exit 1
fi
cd "$release/backend"
if ! pg_isready -q; then
    pg_major="$(pg_lsclusters --no-header | awk '$2 == "main" { print $1; exit }')"
    sudo pg_ctlcluster --skip-systemctl-redirect "$pg_major" main start
fi
listener_pid() {
    ss -H -ltnp "( sport = :$1 )" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1
}
client_node() {
    local executable directory
    executable="$(readlink "/proc/$1/exe" 2>/dev/null)" || return 1
    directory="$(readlink "/proc/$1/cwd" 2>/dev/null)" || return 1
    [[ "$executable" == */node ]] || return 1
    case "$directory" in "$HOME"/.local/share/miaoshou-auto/releases/*/backend) return 0 ;; esac
    return 1
}
web_listener="$(listener_pid 8080)"
if [[ -n "$web_listener" ]] && client_node "$web_listener"; then
    backend_status="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --max-time 2 http://127.0.0.1:3000/auth/session 2>/dev/null || true)"
    if [[ "$backend_status" == 000 || -z "$backend_status" ]]; then
        kill "$web_listener"
        printf 'Stopped a client web process without a reachable backend (PID %s).\n' "$web_listener"
        for attempt in 1 2 3 4 5; do
            if [[ -z "$(listener_pid 8080)" ]]; then break; fi
            sleep 1
        done
    fi
fi
if [[ -n "$(listener_pid 8080)" ]]; then
    printf '%s\n' 'Port 8080 is still in use. Another client window or application is running.' >&2
    if command -v ss >/dev/null 2>&1; then ss -ltnp '( sport = :8080 )' >&2 || true; fi
    web_listener="$(listener_pid 8080)"
    if [[ -n "$web_listener" ]]; then
        printf 'Listener PID %s: executable=%s directory=%s parent=%s\n' "$web_listener" \
            "$(readlink "/proc/$web_listener/exe" 2>/dev/null || printf unknown)" \
            "$(readlink "/proc/$web_listener/cwd" 2>/dev/null || printf unknown)" \
            "$(awk '/^PPid:/ { print $2 }' "/proc/$web_listener/status" 2>/dev/null || printf unknown)" >&2
    fi
    exit 1
fi
node dist/server.js &
backend_pid=$!
node dist/cli/local-http-server.js &
web_pid=$!
cleanup() {
    trap - EXIT INT TERM HUP
    kill "$backend_pid" "$web_pid" 2>/dev/null || true
    wait "$backend_pid" "$web_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP
for attempt in $(seq 1 30); do
    if ! kill -0 "$backend_pid" 2>/dev/null || ! kill -0 "$web_pid" 2>/dev/null; then
        printf '%s\n' 'A client process stopped during startup. See the error above.' >&2
        exit 1
    fi
    if curl --noproxy '*' --silent --fail --max-time 2 http://127.0.0.1:8080/ >/dev/null &&
        curl --noproxy '*' --silent --fail --max-time 2 http://127.0.0.1:8080/auth/session >/dev/null; then
        printf '%s\n' 'Client ready at http://127.0.0.1:8080/'
        printf '%s\n' 'Keep this window open while using the client.'
        if command -v cmd.exe >/dev/null 2>&1; then
            cmd.exe /c start '""' http://127.0.0.1:8080/ >/dev/null 2>&1 || true
        fi
        if wait -n "$backend_pid" "$web_pid"; then :; fi
        printf '%s\n' 'A client process stopped. Run run-client.cmd to restart.' >&2
        exit 1
    fi
    sleep 1
done
printf '%s\n' 'Client startup timed out. See the errors above.' >&2
exit 1
