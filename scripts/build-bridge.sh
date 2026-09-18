#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
: "${STS2_GAME_DIR:?Set STS2_GAME_DIR to your Slay the Spire 2 installation directory}"
dotnet_bin="${DOTNET_BIN:-dotnet}"
source_dir="$repo_dir/vendor/STS2MCP"
if [[ -e "$source_dir" ]]; then
  echo 'vendor/STS2MCP already exists; inspect it before rebuilding (not overwritten).' >&2
  exit 1
fi
mkdir -p "$repo_dir/vendor"
git clone https://github.com/Gennadiyev/STS2MCP.git "$source_dir"
git -C "$source_dir" checkout --detach 55e064850a68f3b4cde7e5fd525bf9b2dec4e885
git -C "$source_dir" apply --check "$repo_dir/bridge/local.patch"
git -C "$source_dir" apply "$repo_dir/bridge/local.patch"
DOTNET_CLI_TELEMETRY_OPTOUT=1 "$dotnet_bin" build "$source_dir/STS2_MCP.csproj" -c Release -o "$repo_dir/out/bridge" "-p:STS2GameDir=$STS2_GAME_DIR"
cp "$source_dir/mod_manifest.json" "$repo_dir/out/bridge/STS2_MCP.json"
echo 'Built out/bridge. With the game closed, install STS2_MCP.dll and STS2_MCP.json as documented.'
