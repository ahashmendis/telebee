@echo off
setlocal
cd /d "%~dp0"
node setup.js --ngrok
pause
