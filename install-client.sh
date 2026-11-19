#!/usr/bin/env bash
set -euo pipefail

source_dir="${1:-$(cd -- "$(dirname -- "$0")" && pwd)}"
if [[ "$(uname -r)" != *WSL2* ]] || [[ "$(. /etc/os-release; printf '%s' "$ID")" != ubuntu ]]; then
    printf '%s\n' 'This installer requires Ubuntu on WSL2.' >&2
    exit 2
fi
if [[ "$(id -u)" == 0 ]]; then
    printf '%s\n' 'Run this installer as the normal WSL user.' >&2
    exit 2
fi
if [[ "$(cat /proc/1/comm)" != systemd ]]; then
    printf '%s\n' 'Enable systemd in this WSL distribution and restart WSL before installing.' >&2
    exit 2
fi
if [[ ! -f "$source_dir/deployment-manifest.json" ]]; then
    printf '%s\n' 'Release manifest is missing.' >&2
    exit 2
fi
manifest_hash="$(sha256sum "$source_dir/deployment-manifest.json" | cut -c1-16)"
release="$HOME/.local/share/miaoshou-auto/releases/$manifest_hash"
backend_unit=/etc/systemd/system/miaoshou-client-backend.service
web_unit=/etc/systemd/system/miaoshou-client-web.service
if sudo test -e "$backend_unit"; then
    if ! sudo grep -Fq "$release/backend/dist/server.js" "$backend_unit"; then
        printf '%s\n' 'Another client version is installed. Use the safe update workflow.' >&2
        exit 3
    fi
    if sudo systemctl is-active --quiet miaoshou-client-backend.service &&
        sudo systemctl is-active --quiet miaoshou-client-web.service &&
        curl --noproxy '*' --silent --fail http://127.0.0.1:8080/ >/dev/null &&
        curl --noproxy '*' --silent --fail http://127.0.0.1:8080/auth/session >/dev/null; then
        printf '%s\n' 'The installed client is already running at http://127.0.0.1:8080/'
        exit 0
    fi
fi
sudo -v
package_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -qx 'install ok installed'; }
missing_packages=()
for package in ca-certificates curl gnupg git jq openssl postgresql postgresql-contrib; do
    if ! package_installed "$package"; then missing_packages+=("$package"); fi
done
if (( ${#missing_packages[@]} )); then
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}"
fi

if ! command -v node >/dev/null || ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22||major===22&&minor>=19?0:1)' >/dev/null; then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/nodesource.gpg
    printf '%s\n' 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main' |
        sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    sudo apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22||major===22&&minor>=19?0:1)'

sudo systemctl enable --now postgresql
pg_major="$(sudo -u postgres psql -Atqc 'SHOW server_version' | cut -d. -f1)"
pgvector_package="postgresql-${pg_major}-pgvector"
if ! apt-cache show "$pgvector_package" >/dev/null 2>&1; then
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/postgresql.gpg
    codename="$(. /etc/os-release; printf '%s' "$VERSION_CODENAME")"
    printf 'deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$codename" |
        sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null
    sudo apt-get update
fi
if ! package_installed "$pgvector_package"; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$pgvector_package"
fi
sudo -u postgres psql -Atqc "SELECT default_version FROM pg_available_extensions WHERE name='vector'" | grep -q .

node "$source_dir/install-client.mjs" prepare "$source_dir" "$release"
cd "$release/backend"
if [[ ! -d node_modules ]] || ! npm ls --omit=dev --depth=0 >/dev/null 2>&1; then
    npm ci --omit=dev --no-audit --no-fund
fi
./node_modules/.bin/playwright install chromium
if ! node --input-type=module -e 'import { chromium } from "playwright"; const browser = await chromium.launch({headless:true}); await browser.close()' >/dev/null 2>&1; then
    sudo env PATH="$PATH" ./node_modules/.bin/playwright install-deps chromium
    node --input-type=module -e 'import { chromium } from "playwright"; const browser = await chromium.launch({headless:true}); await browser.close()'
fi
node --input-type=module -e 'import sharp from "sharp"; import { chromium } from "playwright"; await sharp({create:{width:1,height:1,channels:3,background:"white"}}).png().toBuffer(); if (!chromium.executablePath()) process.exit(1)'

config="$HOME/.config/miaoshou-auto/client.env"
node "$release/install-client.mjs" configure "$config"
db_password="$(node "$release/install-client.mjs" db-password "$config")"
role_exists="$(sudo -u postgres psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname='miaoshou_client'")"
if [[ -z "$role_exists" ]]; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE miaoshou_client LOGIN SUPERUSER CREATEDB PASSWORD '$db_password'" >/dev/null
fi
PGPASSWORD="$db_password" psql -h 127.0.0.1 -U miaoshou_client -d postgres -Atqc 'SELECT 1' | grep -qx 1
if [[ ! -e "$release/backend/.env" ]]; then ln -s "$config" "$release/backend/.env"; fi
if [[ "$(readlink -f "$release/backend/.env")" != "$config" ]]; then
    printf '%s\n' 'Release configuration link points to another file.' >&2
    exit 3
fi

node_path="$(command -v node)"
if ! sudo test -e "$backend_unit"; then
    printf '[Unit]\nDescription=Miaoshou Client Backend\nAfter=network-online.target postgresql.service\nWants=network-online.target\n[Service]\nType=simple\nUser=%s\nWorkingDirectory=%s/backend\nExecStart=%s %s/backend/dist/server.js\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n' \
        "$USER" "$release" "$node_path" "$release" | sudo tee "$backend_unit" >/dev/null
fi
if ! sudo test -e "$web_unit"; then
    printf '[Unit]\nDescription=Miaoshou Client Web\nAfter=miaoshou-client-backend.service\nRequires=miaoshou-client-backend.service\n[Service]\nType=simple\nUser=%s\nWorkingDirectory=%s/backend\nExecStart=%s %s/backend/dist/cli/local-http-server.js\nRestart=on-failure\n[Install]\nWantedBy=multi-user.target\n' \
        "$USER" "$release" "$node_path" "$release" | sudo tee "$web_unit" >/dev/null
fi
sudo systemctl daemon-reload
sudo systemctl enable --now miaoshou-client-backend.service miaoshou-client-web.service
for attempt in $(seq 1 30); do
    if curl --noproxy '*' --silent --fail http://127.0.0.1:8080/ >/dev/null &&
        curl --noproxy '*' --silent --fail http://127.0.0.1:8080/auth/session >/dev/null &&
        sudo systemctl is-active --quiet miaoshou-client-backend.service; then
        printf '%s\n' 'Miaoshou client is running at http://127.0.0.1:8080/'
        exit 0
    fi
    sleep 1
done
printf '%s\n' 'Client services did not become ready. Check systemctl status and journalctl.' >&2
exit 1
