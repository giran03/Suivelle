@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0clean-cache.ps1" %*
set "result=%errorlevel%"
echo.
pause
exit /b %result%
