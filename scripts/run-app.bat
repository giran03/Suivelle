@echo off
setlocal
cd /d "%~dp0.." || exit /b 1
if not exist "src-tauri\target\release\Suivelle.exe" (
  call npm run tauri -- build --no-bundle
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
start "" "src-tauri\target\release\Suivelle.exe"
exit /b %errorlevel%
