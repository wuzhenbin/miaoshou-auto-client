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
    printf '%s\n' 'PostgreSQL is unavailable. Run run-client.cmd again to start it.' >&2
    exit 1
fi
listener_pid() {
    ss -H -ltnp "( sport = :$1 )" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1
}
client_node() {
    local executable directory
    executable="$(readlink "/proc/$1/exe" 2>/dev/null)" || return 1
    directory="$(readlink "/proc/$1/cwd" 2>/dev/null)" || return 1
    [[ "$executable" == */node ]] || return 1
    case "$directory" in
        "$HOME"/.local/share/miaoshou-auto/releases/*/backend|"$HOME"/miaoshou-auto/backend) return 0 ;;
    esac
    return 1
}
web_listener="$(listener_pid 8080)"
if [[ -n "$web_listener" ]] &&
    [[ "$(readlink "/proc/$web_listener/cwd" 2>/dev/null)" == "$release/backend" ]] &&
    [[ "$(readlink "/proc/$(listener_pid 3000)/cwd" 2>/dev/null)" == "$release/backend" ]]; then
    printf '%s\n' 'This client version is already running at http://127.0.0.1:8080/'
    if command -v cmd.exe >/dev/null 2>&1; then
        cmd.exe /c start '""' http://127.0.0.1:8080/ >/dev/null 2>&1 || true
    fi
    exit 0
fi
if [[ -n "$web_listener" ]] && client_node "$web_listener"; then
    web_directory="$(readlink "/proc/$web_listener/cwd" 2>/dev/null || true)"
    backend_status="$(curl --noproxy '*' --silent --output /dev/null --write-out '%{http_code}' --max-time 2 http://127.0.0.1:3000/auth/session 2>/dev/null || true)"
    if [[ "$web_directory" == "$HOME/miaoshou-auto/backend" || "$backend_status" == 000 || -z "$backend_status" ]]; then
        kill "$web_listener"
        printf 'Stopped the old client web process (PID %s).\n' "$web_listener"
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
backend_listener="$(listener_pid 3000)"
if [[ -n "$backend_listener" ]] && client_node "$backend_listener" &&
    [[ "$(readlink "/proc/$backend_listener/cwd" 2>/dev/null)" == "$HOME/miaoshou-auto/backend" ]]; then
    old_session="$(curl --noproxy '*' --silent --fail --max-time 3 http://127.0.0.1:3000/client-account/session 2>/dev/null || true)"
    old_health="$(curl --noproxy '*' --silent --fail --max-time 3 http://127.0.0.1:3000/product-runtime-health 2>/dev/null || true)"
    if jq -e '.state == null and .runtimeAccount == null' >/dev/null 2>&1 <<<"$old_session" ||
        jq -e '.maintenance == true and (.execution.activeProducts // 0) == 0 and (.execution.activeAdvances // 0) == 0 and ((.execution.executions // []) | length) == 0 and (.scheduler.admissions.writes.active // 0) == 0 and (.scheduler.admissions.writes.queued // 0) == 0' >/dev/null 2>&1 <<<"$old_health"; then
        kill "$backend_listener"
        printf 'Stopped the idle old client backend (PID %s).\n' "$backend_listener"
        for attempt in 1 2 3 4 5; do
            if [[ -z "$(listener_pid 3000)" ]]; then break; fi
            sleep 1
        done
        backend_listener="$(listener_pid 3000)"
    fi
fi
if [[ -n "$backend_listener" ]]; then
    printf '%s\n' 'Port 3000 is already in use; the new backend cannot start.' >&2
    ss -ltnp '( sport = :3000 )' >&2 || true
    printf 'Listener PID %s: executable=%s directory=%s parent=%s\n' "$backend_listener" \
        "$(readlink "/proc/$backend_listener/exe" 2>/dev/null || printf unknown)" \
        "$(readlink "/proc/$backend_listener/cwd" 2>/dev/null || printf unknown)" \
        "$(awk '/^PPid:/ { print $2 }' "/proc/$backend_listener/status" 2>/dev/null || printf unknown)" >&2
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
        if ! kill -0 "$backend_pid" 2>/dev/null || ! kill -0 "$web_pid" 2>/dev/null; then
            printf '%s\n' 'A client process stopped during startup. See the error above.' >&2
            exit 1
        fi
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
