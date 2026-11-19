#!/usr/bin/env bash
set -euo pipefail

source_dir="$1"
release="$2"
config="$3"
node "$source_dir/install-client.mjs" prepare "$source_dir" "$release"
cd "$release/backend"
if [[ ! -d node_modules ]] || ! npm ls --omit=dev --depth=0 >/dev/null 2>&1; then
    npm ci --omit=dev --no-audit --no-fund
fi
./node_modules/.bin/playwright install chromium
if ! node --input-type=module -e 'import { chromium } from "playwright"; const browser = await chromium.launch({headless:true}); await browser.close()' >/dev/null 2>&1; then
    exit 42
fi
node --input-type=module -e 'import sharp from "sharp"; import { chromium } from "playwright"; await sharp({create:{width:1,height:1,channels:3,background:"white"}}).png().toBuffer(); if (!chromium.executablePath()) process.exit(1)'
node "$release/install-client.mjs" configure "$config"
if [[ ! -e "$release/backend/.env" ]]; then ln -s "$config" "$release/backend/.env"; fi
if [[ "$(readlink -f "$release/backend/.env")" != "$config" ]]; then
    printf '%s\n' 'Release configuration link points to another file.' >&2
    exit 3
fi
