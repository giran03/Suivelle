@echo off
setlocal
cd /d "%~dp0.." || exit /b 1
call npm run tauri dev
set "exit_code=%errorlevel%"
if not "%exit_code%"=="0" pause
exit /b %exit_code%
