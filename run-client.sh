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
# A previous Windows launcher could exit while leaving its Node children orphaned in WSL.
stopped_orphan=0
for process in /proc/[0-9]*; do
    process_id="${process##*/}"
    process_cwd="$(readlink "$process/cwd" 2>/dev/null)" || continue
    case "$process_cwd" in "$HOME"/.local/share/miaoshou-auto/releases/*/backend) ;; *) continue ;; esac
    process_parent="$(awk '/^PPid:/ { print $2 }' "$process/status" 2>/dev/null)" || continue
    [[ "$process_parent" == 1 ]] || continue
    process_args=()
    mapfile -d '' -t process_args < "$process/cmdline" 2>/dev/null || continue
    [[ "${process_args[0]:-}" == node || "${process_args[0]:-}" == */node ]] || continue
    case "${process_args[1]:-}" in
        dist/server.js|dist/cli/local-http-server.js|*/backend/dist/server.js|*/backend/dist/cli/local-http-server.js)
            kill "$process_id" 2>/dev/null || true
            printf 'Stopped an orphaned client process (%s).\n' "$process_id"
            stopped_orphan=1
            ;;
    esac
done
if [[ "$stopped_orphan" == 1 ]]; then
    for attempt in 1 2 3 4 5; do
        if ! curl --noproxy '*' --silent --fail --max-time 1 http://127.0.0.1:8080/ >/dev/null; then break; fi
        sleep 1
    done
fi
if curl --noproxy '*' --silent --fail --max-time 2 http://127.0.0.1:8080/ >/dev/null; then
    printf '%s\n' 'Port 8080 is still in use. Close the other client window or application first.' >&2
    if command -v ss >/dev/null 2>&1; then ss -ltnp '( sport = :8080 )' >&2 || true; fi
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
