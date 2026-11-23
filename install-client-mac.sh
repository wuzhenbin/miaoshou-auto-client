#!/bin/bash
set -euo pipefail

source_dir="${1:-$(cd -- "$(dirname -- "$0")" && pwd)}"
if [[ "$(uname -s)" != Darwin ]]; then
    printf '%s\n' 'This installer requires macOS.' >&2
    exit 2
fi
if [[ ! -f "$source_dir/deployment-manifest.json" ]]; then
    printf '%s\n' 'Release manifest is missing.' >&2
    exit 2
fi
if ! command -v brew >/dev/null; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$candidate" ]]; then brew_bin="$candidate"; break; fi
done
if [[ -z "${brew_bin:-}" ]]; then
    printf '%s\n' 'Homebrew installation did not complete.' >&2
    exit 2
fi
"$brew_bin" install git node@24 postgresql@17 pgvector
"$brew_bin" services start postgresql@17
node_path="$("$brew_bin" --prefix node@24)/bin/node"
pg_bin="$("$brew_bin" --prefix postgresql@17)/bin"
export PATH="$(dirname "$node_path"):$pg_bin:$PATH"
"$node_path" -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22||major===22&&minor>=19?0:1)'
"$pg_bin/psql" -d postgres -Atqc "SELECT default_version FROM pg_available_extensions WHERE name='vector'" | grep -q .

manifest_hash="$(shasum -a 256 "$source_dir/deployment-manifest.json" | cut -c1-16)"
release="$HOME/Library/Application Support/MiaoshouAuto/releases/$manifest_hash"
backend_plist="$HOME/Library/LaunchAgents/com.miaoshou.client.backend.plist"
web_plist="$HOME/Library/LaunchAgents/com.miaoshou.client.web.plist"
if [[ -e "$backend_plist" ]]; then
    if ! grep -Fq "$release/backend/dist/server.js" "$backend_plist"; then
        printf '%s\n' 'Another client version is installed. Use the safe update workflow.' >&2
        exit 3
    fi
    if launchctl print "gui/$(id -u)/com.miaoshou.client.backend" >/dev/null 2>&1 &&
        launchctl print "gui/$(id -u)/com.miaoshou.client.web" >/dev/null 2>&1 &&
        curl --noproxy '*' --silent --fail http://127.0.0.1:8080/ >/dev/null; then
        open http://127.0.0.1:8080/
        exit 0
    fi
fi

"$node_path" "$source_dir/install-client.mjs" prepare "$source_dir" "$release"
cd "$release/backend"
npm ci --omit=dev --no-audit --no-fund
./node_modules/.bin/playwright install chromium
"$node_path" --input-type=module -e 'import sharp from "sharp"; import { chromium } from "playwright"; await sharp({create:{width:1,height:1,channels:3,background:"white"}}).png().toBuffer(); if (!chromium.executablePath()) process.exit(1)'

config="$HOME/Library/Application Support/MiaoshouAuto/private/client.env"
"$node_path" "$release/install-client.mjs" configure "$config"
db_password="$("$node_path" "$release/install-client.mjs" db-password "$config")"
role_exists="$("$pg_bin/psql" -d postgres -Atqc "SELECT 1 FROM pg_roles WHERE rolname='miaoshou_client'")"
if [[ -z "$role_exists" ]]; then
    "$pg_bin/psql" -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE miaoshou_client LOGIN SUPERUSER CREATEDB PASSWORD '$db_password'" >/dev/null
fi
PGPASSWORD="$db_password" "$pg_bin/psql" -h 127.0.0.1 -U miaoshou_client -d postgres -Atqc 'SELECT 1' | grep -qx 1
if [[ ! -e "$release/backend/.env" ]]; then ln -s "$config" "$release/backend/.env"; fi
if [[ "$(readlink "$release/backend/.env")" != "$config" ]]; then
    printf '%s\n' 'Release configuration link points to another file.' >&2
    exit 3
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.miaoshou-auto/logs"
xml_escape() { printf '%s' "$1" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
write_plist() {
    local path="$1" label="$2" entry="$3" log="$4"
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
        '<plist version="1.0"><dict>' \
        '<key>Label</key><string>'"$(xml_escape "$label")"'</string>' \
        '<key>ProgramArguments</key><array><string>'"$(xml_escape "$node_path")"'</string><string>'"$(xml_escape "$entry")"'</string></array>' \
        '<key>WorkingDirectory</key><string>'"$(xml_escape "$release/backend")"'</string>' \
        '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>' \
        '<key>StandardOutPath</key><string>'"$(xml_escape "$log")"'</string>' \
        '<key>StandardErrorPath</key><string>'"$(xml_escape "$log")"'</string>' \
        '</dict></plist>' > "$path"
    plutil -lint "$path" >/dev/null
}
if [[ ! -e "$backend_plist" ]]; then
    write_plist "$backend_plist" com.miaoshou.client.backend "$release/backend/dist/server.js" "$HOME/.miaoshou-auto/logs/client-backend.log"
fi
if [[ ! -e "$web_plist" ]]; then
    write_plist "$web_plist" com.miaoshou.client.web "$release/backend/dist/cli/local-http-server.js" "$HOME/.miaoshou-auto/logs/client-web.log"
fi
for label in com.miaoshou.client.backend com.miaoshou.client.web; do
    if ! launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
        launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist"
    fi
done
for attempt in $(seq 1 30); do
    if curl --noproxy '*' --silent --fail http://127.0.0.1:8080/ >/dev/null; then
        open http://127.0.0.1:8080/
        printf '%s\n' 'Miaoshou client is running at http://127.0.0.1:8080/'
        exit 0
    fi
    sleep 1
done
printf '%s\n' 'Client services did not become ready. Check launchctl and the local logs.' >&2
exit 1
