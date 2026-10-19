@echo off
setlocal
title AssetVault - LOCAL licensing test

REM ============================================================
REM  Local end-to-end test for the ONLINE activation flow.
REM
REM  Note: the shipped build now uses OFFLINE licensing (user sends
REM  their machine fingerprint, you sign a license file with
REM  tools\keygen.mjs sign). This script is only for testing the
REM  optional online path (license-server + key) on this machine.
REM
REM  Usage:
REM    test-local-license.cmd
REM    test-local-license.cmd "C:\full\path\to\AssetVault.exe"
REM ============================================================

set "HERE=%~dp0"
set "PORT=8787"
set "AV_LICENSE_SERVER=http://127.0.0.1:%PORT%/api/activate"

echo ============================================================
echo   AssetVault - local ONLINE licensing test
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js not found in PATH. Install Node.js 22+ first.
  pause
  exit /b 1
)

echo [1/3] Starting local license server on port %PORT% ...
start "AssetVault License Server (LOCAL TEST)" cmd /k "cd /d "%~dp0." && set PORT=%PORT% && node license-server\server.mjs"

echo [2/3] Waiting for the server to come up ...
timeout /t 3 /nobreak >nul

echo [3/3] Launching AssetVault (license server overridden) ...
set "APP="
if not "%~1"=="" if exist "%~1" set "APP=%~1"
if not defined APP if exist "%HERE%src-tauri\target\release\assetvault.exe" set "APP=%HERE%src-tauri\target\release\assetvault.exe"
if not defined APP if exist "%ProgramFiles%\AssetVault\AssetVault.exe" set "APP=%ProgramFiles%\AssetVault\AssetVault.exe"
if not defined APP if exist "%LOCALAPPDATA%\AssetVault\AssetVault.exe" set "APP=%LOCALAPPDATA%\AssetVault\AssetVault.exe"
if not defined APP (
  echo ERROR: AssetVault.exe not found.
  echo Pass its path as the first argument, for example:
  echo    test-local-license.cmd "C:\Program Files\AssetVault\AssetVault.exe"
  pause
  exit /b 1
)

echo   APP            = %APP%
echo   LICENSE SERVER = %AV_LICENSE_SERVER%
start "" "%APP%"

echo.
echo ------------------------------------------------------------
echo  No key is created for you. Make one first, then type it in:
echo.
echo     node tools\keygen.mjs new
echo.
echo  (it prints a key like AV-XXXXX-XXXXX-XXXXX-XXXXX)
echo.
echo  In the activation window: click "use key / online", paste the
echo  key, press Activate. It should succeed against the LOCAL server.
echo.
echo  NOTE: keep the "License Server" window open while testing;
echo        close it when you are done.
echo ------------------------------------------------------------
echo.
pause
