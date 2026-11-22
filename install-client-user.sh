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
node --input-type=module -e 'import sharp from "sharp"; await sharp({create:{width:1,height:1,channels:3,background:"white"}}).png().toBuffer()'
node "$release/install-client.mjs" configure "$config"
if [[ ! -e "$release/backend/.env" ]]; then ln -s "$config" "$release/backend/.env"; fi
if [[ "$(readlink -f "$release/backend/.env")" != "$config" ]]; then
    printf '%s\n' 'Release configuration link points to another file.' >&2
    exit 3
fi
