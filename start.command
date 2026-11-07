#!/bin/zsh
set -e
cd "${0:A:h}"

node_version=22.19.0
runtime_dir="$HOME/.miaoshou-auto/client-runtime/node"
node_bin=""
if command -v node >/dev/null 2>&1 && node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&(b>19||b===19&&c>=0)?0:1)' 2>/dev/null; then
  node_bin="$(command -v node)"
else
  case "$(uname -m)" in
    arm64) platform=darwin-arm64 ;;
    x86_64) platform=darwin-x64 ;;
    *) print -u2 "不支持的 macOS CPU 架构"; exit 1 ;;
  esac
  install_dir="$runtime_dir/node-v$node_version-$platform"
  node_bin="$install_dir/bin/node"
  if [[ ! -x "$node_bin" ]]; then
    archive="node-v$node_version-$platform.tar.gz"
    temp_dir="$(mktemp -d)"
    trap 'rm -rf "$temp_dir"' EXIT
    print "正在下载 Node.js $node_version..."
    curl -fLsS "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$temp_dir/SHASUMS256.txt"
    curl -fLsS "https://nodejs.org/dist/v$node_version/$archive" -o "$temp_dir/$archive"
    expected="$(awk -v file="$archive" '$2 == file { print $1 }' "$temp_dir/SHASUMS256.txt")"
    actual="$(shasum -a 256 "$temp_dir/$archive" | awk '{ print $1 }')"
    [[ -n "$expected" && "$expected" == "$actual" ]] || { print -u2 "Node.js 下载校验失败"; exit 1; }
    mkdir -p "$runtime_dir"
    tar -xzf "$temp_dir/$archive" -C "$runtime_dir"
  fi
fi

"$node_bin" scripts/run-local.mjs
result=$?
print "客户端已退出，按回车关闭窗口。"
read
exit "$result"
