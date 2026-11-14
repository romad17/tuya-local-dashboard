@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env - open it, fill in TUYA_ACCESS_ID and TUYA_ACCESS_SECRET, then run start.bat again.
  notepad .env
  exit /b
)
start "" http://localhost:3000
node server.js
pause
