@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================================
echo  AssetVault desktop installer - one-click build (Tauri / NSIS)
echo ============================================================
echo.

REM 0) Make sure the Rust toolchain is on PATH (rustup installs to %USERPROFILE%\.cargo\bin)
where cargo >nul 2>nul
if errorlevel 1 (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  where cargo >nul 2>nul || ( echo ERROR: cargo not found. Install Rust via https://rustup.rs & pause & exit /b 1 )
)

REM 1) Node.js >= 22
where node >nul 2>nul
if errorlevel 1 ( echo ERROR: Node.js not found. & pause & exit /b 1 )
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if errorlevel 1 ( echo ERROR: Node.js 22 or newer is required. & pause & exit /b 1 )
echo [1] Node.js check passed.

REM 2) Build the library frontend in the parent project -> dist/library
REM 桌面工程是库工程的子目录（不是兄弟目录），所以库工程就是上一级。
set "LIB=%~dp0.."
echo [2] Building parent library frontend (npm run build:library) ...
pushd "%LIB%"
if not exist node_modules\ ( call npm install )
call npm run build:library
if errorlevel 1 ( echo ERROR: build:library failed. & popd & pause & exit /b 1 )
popd
echo     library frontend built.

REM 3) Assemble the sidecar server from the parent project (server + dist/library + vendor binaries)
echo [3] Assembling sidecar-server (scripts/build-sidecar.mjs) ...
if not exist node_modules\ ( call npm install )
set "LIBRARY_PROJECT=%LIB%"
node scripts/build-sidecar.mjs
if errorlevel 1 ( echo ERROR: build-sidecar failed - missing node runtime / chrome / vendor? & pause & exit /b 1 )

REM Old installers are cleaned by npm run build only after the new bundle succeeds.

REM 4) Tauri build -> NSIS setup.exe (compiles Rust, bundles the installer)
echo [4] tauri build (Rust compile + NSIS bundle) ...
call npm run build
if errorlevel 1 ( echo ERROR: tauri build failed. & pause & exit /b 1 )

echo.
echo ============================================================
echo  DONE. Installer:
for /f "tokens=*" %%f in ('dir /b /o:-d dist\AssetVault_*_x64-setup.exe 2^>nul') do (
  echo    %~dp0dist\%%f
  goto :showdone
)
:showdone
echo ============================================================
echo.
pause
