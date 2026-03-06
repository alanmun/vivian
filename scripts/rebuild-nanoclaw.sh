#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SKIP_CONTAINER=0
for arg in "$@"; do
  case "$arg" in
    --skip-container) SKIP_CONTAINER=1 ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--skip-container]"
      exit 1
      ;;
  esac
done

load_node() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1090
    source "$HOME/.nvm/nvm.sh"
    if [ -f ".nvmrc" ]; then
      nvm use >/dev/null 2>&1 || nvm use 24 >/dev/null 2>&1 || true
    else
      nvm use 24 >/dev/null 2>&1 || true
    fi
  fi
}

stop_service() {
  if command -v systemctl >/dev/null 2>&1; then
    echo "Stopping nanoclaw (systemd --user)..."
    if systemctl --user stop nanoclaw >/dev/null 2>&1; then
      return
    fi
  fi

  if command -v launchctl >/dev/null 2>&1; then
    if launchctl print "gui/$(id -u)/com.nanoclaw" >/dev/null 2>&1; then
      echo "Stopping nanoclaw (launchctl)..."
      launchctl bootout "gui/$(id -u)/com.nanoclaw" || true
      return
    fi
  fi

  echo "No running nanoclaw service manager detected; continuing."
}

start_service() {
  if command -v systemctl >/dev/null 2>&1; then
    echo "Starting nanoclaw (systemd --user)..."
    if systemctl --user start nanoclaw >/dev/null 2>&1; then
      return
    fi
  fi

  if command -v launchctl >/dev/null 2>&1; then
    local plist="$HOME/Library/LaunchAgents/com.nanoclaw.plist"
    if [ -f "$plist" ]; then
      echo "Starting nanoclaw (launchctl)..."
      launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || true
      launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
      return
    fi
  fi

  echo "No service manager configured to start nanoclaw."
  exit 1
}

load_node

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found in PATH. Ensure Node.js is installed and active (e.g., via nvm)."
  exit 1
fi

echo "=== NanoClaw rebuild ==="
stop_service

echo "Building TypeScript..."
npm run build

if [ "$SKIP_CONTAINER" -eq 0 ]; then
  echo "Rebuilding agent container..."
  ./container/build.sh
else
  echo "Skipping container rebuild (--skip-container)."
fi

start_service
echo "Done."
