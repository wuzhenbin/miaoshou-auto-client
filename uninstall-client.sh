#!/usr/bin/env bash
set -euo pipefail
remove_data=false
[[ "${1:-}" == "--remove-data" ]] && remove_data=true
install_root="$HOME/.local/share/miaoshou-auto"
read -r -p "输入 UNINSTALL 确认卸载 WSL2 客户端：" answer
if [[ "$answer" != UNINSTALL ]]; then printf '%s\n' '已取消。'; exit 0; fi
if command -v ss >/dev/null 2>&1; then
    for port in 3000 8080; do
        pid="$(ss -H -ltnp "( sport = :$port )" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1)"
        [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    done
fi
rm -rf -- "$install_root"
if $remove_data; then
    rm -rf -- "$HOME/.miaoshou-auto" "$HOME/.miaoshou-auto-accounts"
fi
printf '%s\n' 'WSL2 客户端已卸载。'
