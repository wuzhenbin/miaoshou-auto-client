#!/usr/bin/env bash
set -euo pipefail

source_dir="$1"
client_user="$2"
node_path="${3:-}"
if [[ "$(id -u)" != 0 ]] || [[ "$(uname -r)" != *WSL2* ]] || [[ "$(. /etc/os-release; printf '%s' "$ID")" != ubuntu ]]; then
    printf '%s\n' 'This installer requires root in Ubuntu on WSL2.' >&2
    exit 2
fi
if [[ ! -f "$source_dir/deployment-manifest.json" ]] || [[ "$client_user" == root ]]; then
    printf '%s\n' 'Release files or the normal WSL user are missing.' >&2
    exit 2
fi
client_home="$(getent passwd "$client_user" | cut -d: -f6)"
if [[ -z "$client_home" || ! -d "$client_home" ]]; then
    printf '%s\n' 'The normal WSL user has no home directory.' >&2
    exit 2
fi
manifest_hash="$(sha256sum "$source_dir/deployment-manifest.json" | cut -c1-16)"
release="$client_home/.local/share/miaoshou-auto/releases/$manifest_hash"
config="$client_home/.config/miaoshou-auto/client.env"
package_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -qx 'install ok installed'; }
if [[ ! -f "$release/.install-complete" || ! -f "$config" ]]; then
    missing_packages=()
    for package in ca-certificates curl gnupg git jq openssl postgresql; do
        if ! package_installed "$package"; then missing_packages+=("$package"); fi
    done
    if (( ${#missing_packages[@]} )); then
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}"
    fi
    if [[ ! -x "$node_path" ]] || ! runuser -u "$client_user" -- "$node_path" -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22||major===22&&minor>=19?0:1)'; then
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/nodesource.gpg
        printf '%s\n' 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
        node_path=/usr/bin/node
    fi
fi
pg_major="$(pg_lsclusters --no-header | awk '$2 == "main" { print $1; exit }')"
if [[ -z "$pg_major" ]]; then
    printf '%s\n' 'PostgreSQL main cluster is missing.' >&2
    exit 2
fi
if ! pg_isready -q; then pg_ctlcluster --skip-systemctl-redirect "$pg_major" main start; fi
legacy_directory="$client_home/miaoshou-auto/backend"
listener_pid() {
    ss -H -ltnp "( sport = :$1 )" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1
}
is_legacy_node() {
    local executable directory
    executable="$(readlink "/proc/$1/exe" 2>/dev/null)" || return 1
    directory="$(readlink "/proc/$1/cwd" 2>/dev/null)" || return 1
    [[ "$executable" == */node && "$directory" == "$legacy_directory" ]]
}
stop_legacy_node() {
    local pid="$1" unit
    unit="$(awk -F/ '{ for (i=1; i<=NF; i++) if ($i ~ /\.service$/) { print $i; exit } }' "/proc/$pid/cgroup" 2>/dev/null | head -n 1)"
    if [[ -n "$unit" && "$(systemctl show -P MainPID "$unit" 2>/dev/null)" == "$pid" ]]; then
        systemctl stop "$unit"
        systemctl disable "$unit" >/dev/null 2>&1 || true
        printf 'Stopped the old client service %s.\n' "$unit"
    else
        kill "$pid"
        printf 'Stopped the old client process %s.\n' "$pid"
    fi
}
backend_pid="$(listener_pid 3000)"
if [[ -n "$backend_pid" ]] && is_legacy_node "$backend_pid"; then
    old_session="$(curl --noproxy '*' --silent --fail --max-time 3 http://127.0.0.1:3000/client-account/session 2>/dev/null || true)"
    old_health="$(curl --noproxy '*' --silent --fail --max-time 3 http://127.0.0.1:3000/product-runtime-health 2>/dev/null || true)"
    if jq -e '.state == null and .runtimeAccount == null' >/dev/null 2>&1 <<<"$old_session" ||
        jq -e '(.execution.activeProducts | type) == "number" and (.scheduler.admissions.writes.active | type) == "number" and (.scheduler.admissions.reads.active | type) == "number" and (.resources.images.activeTasks | type) == "array" and (.resources.browser.activeTasks | type) == "array" and (.execution.activeProducts // 0) == 0 and (.execution.activeAdvances // 0) == 0 and ((.execution.executions // []) | length) == 0 and (.execution.retryScan.running // false) == false and (.execution.recovering // false) == false and (.scheduler.admissions.writes.active // 0) == 0 and (.scheduler.admissions.writes.queued // 0) == 0 and (.scheduler.admissions.reads.active // 0) == 0 and (.scheduler.admissions.reads.queued // 0) == 0 and ((.resources.images.activeTasks // []) | length) == 0 and ((.resources.browser.activeTasks // []) | length) == 0' >/dev/null 2>&1 <<<"$old_health"; then
        stop_legacy_node "$backend_pid"
    else
        printf '%s\n' 'The old backend may have in-flight work. It was left running; check its tasks before switching versions.' >&2
        exit 3
    fi
fi
web_pid="$(listener_pid 8080)"
if [[ -n "$web_pid" ]] && is_legacy_node "$web_pid"; then stop_legacy_node "$web_pid"; fi
for attempt in 1 2 3 4 5; do
    if [[ -z "$(listener_pid 3000)" && -z "$(listener_pid 8080)" ]]; then break; fi
    sleep 1
done
if [[ -f "$release/.install-complete" && -f "$config" ]]; then exit 0; fi

if [[ ! -x "$node_path" ]]; then
    printf '%s\n' 'Node.js is unavailable for the normal WSL user.' >&2
    exit 2
fi
export PATH="$(dirname "$node_path"):$PATH"
pg_major="$(runuser -u postgres -- psql -Atqc 'SHOW server_version' | cut -d. -f1)"
pgvector_package="postgresql-${pg_major}-pgvector"
if ! apt-cache show "$pgvector_package" >/dev/null 2>&1; then
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --batch --yes --dearmor -o /usr/share/keyrings/postgresql.gpg
    codename="$(. /etc/os-release; printf '%s' "$VERSION_CODENAME")"
    printf 'deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$codename" > /etc/apt/sources.list.d/pgdg.list
    apt-get update
fi
if ! package_installed "$pgvector_package"; then DEBIAN_FRONTEND=noninteractive apt-get install -y "$pgvector_package"; fi
runuser -u postgres -- psql -Atqc "SELECT default_version FROM pg_available_extensions WHERE name='vector'" | grep -q .

run_user_install() {
    runuser -u "$client_user" -- env HOME="$client_home" PATH="$PATH" bash "$source_dir/install-client-user.sh" "$source_dir" "$release" "$config"
}
if run_user_install; then :
else
    result=$?
    if [[ "$result" != 42 ]]; then exit "$result"; fi
    cd "$release/backend"
    ./node_modules/.bin/playwright install-deps chromium
    run_user_install
fi
db_password="$(runuser -u "$client_user" -- "$node_path" "$release/install-client.mjs" db-password "$config")"
role_exists="$(runuser -u postgres -- psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname='miaoshou_client'")"
if [[ -z "$role_exists" ]]; then
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "CREATE ROLE miaoshou_client LOGIN SUPERUSER CREATEDB PASSWORD '$db_password'" >/dev/null
fi
runuser -u "$client_user" -- env PGPASSWORD="$db_password" psql -h 127.0.0.1 -U miaoshou_client -d postgres -Atqc 'SELECT 1' | grep -qx 1

backend_unit=/etc/systemd/system/miaoshou-client-backend.service
web_unit=/etc/systemd/system/miaoshou-client-web.service
if [[ -f "$backend_unit" || -f "$web_unit" ]]; then
    if [[ "$(cat /proc/1/comm)" == systemd ]]; then
        for unit in miaoshou-client-backend.service miaoshou-client-web.service; do
            if [[ -f "/etc/systemd/system/$unit" ]]; then systemctl disable --now "$unit"; fi
        done
    fi
    rm -f "$backend_unit" "$web_unit"
    if [[ "$(cat /proc/1/comm)" == systemd ]]; then systemctl daemon-reload; fi
fi
runuser -u "$client_user" -- touch "$release/.install-complete"
printf '%s\n' 'Client dependencies and private configuration are ready.'
