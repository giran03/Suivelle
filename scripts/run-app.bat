@echo off
setlocal
cd /d "%~dp0.." || exit /b 1
node scripts\release-freshness.mjs
if errorlevel 2 exit /b 1
if errorlevel 1 (
  echo Building the updated app...
  call npm run tauri -- build --no-bundle
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
start "" "src-tauri\target\release\Suivelle.exe"
exit /b %errorlevel%
