$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js is required: https://nodejs.org/" -ForegroundColor Red
    Start-Process "https://nodejs.org/"
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "npm is required. Reinstall Node.js and enable npm." -ForegroundColor Red
    exit 1
}

node setup.js
