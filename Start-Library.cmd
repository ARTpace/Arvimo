@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Please install Node.js first.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if errorlevel 1 (
  echo Please update Node.js to version 22 or newer.
  pause
  exit /b 1
)
if not exist node_modules\esbuild (
  echo Dependencies are missing. Run npm install in this folder first.
  pause
  exit /b 1
)
if /i "%~1"=="--foreground" goto foreground

rem Hand off to the silent launcher (Start-Library-Silent.vbs) so that no
rem console window stays open. The library keeps running in the background;
rem see .assetvault\library-server.log for its output.
if not exist "scripts\start-library-background.mjs" (
  echo Missing scripts\start-library-background.mjs.
  pause
  exit /b 1
)
start "" wscript.exe "%~dp0Start-Library-Silent.vbs"
exit /b 0

:foreground
echo Starting AssetVault local model library in foreground mode...
echo Keep this window and this computer running. The webpage can be closed.
call npm run library -- --open
pause
