@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)

rem Credentials can come from system environment variables OR from a .env file.
set NEEDCFG=
if not defined TUYA_ACCESS_ID set NEEDCFG=1
if not defined TUYA_ACCESS_SECRET set NEEDCFG=1
if defined NEEDCFG if not exist .env (
  copy .env.example .env >nul
  echo No TUYA_ACCESS_ID / TUYA_ACCESS_SECRET environment variables found.
  echo Created .env - fill in the values, then run start.bat again.
  notepad .env
  exit /b
)

start "" http://localhost:3000
node server.js
pause
