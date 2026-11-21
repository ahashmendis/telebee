#!/bin/zsh
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  node setup.js
else
  osascript -e 'display dialog "Node.js is required. Install it from https://nodejs.org/ then restart." buttons {"OK"} default button "OK"'
  open "https://nodejs.org/"
fi
