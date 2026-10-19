@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem Install the AssetVault bridge into Blender (a startup script, NOT an addon).
rem Run this once on a new PC, before opening Blender, to skip the "restart Blender" step.

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 22 or newer is required. Install Node.js first, then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "scripts\install-blender-bridge.mjs" (
  echo.
  echo Missing scripts\install-blender-bridge.mjs.
  echo Make sure this file sits in the AssetVault project folder.
  echo.
  pause
  exit /b 1
)

node "scripts\install-blender-bridge.mjs"
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
