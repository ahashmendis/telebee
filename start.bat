@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required.
  echo Install it from https://nodejs.org/
  start "" "https://nodejs.org/"
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required. Reinstall Node.js and enable npm.
  pause
  exit /b 1
)

node setup.js
pause
