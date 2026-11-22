#!/bin/zsh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display dialog "Node.js is required. Install it from https://nodejs.org/ then try again." buttons {"OK"} default button "OK"'
  open "https://nodejs.org/"
  exit 1
fi
node setup.js --ngrok
