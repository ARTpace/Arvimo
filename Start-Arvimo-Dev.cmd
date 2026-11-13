@echo off
if /i "%~1"=="--console" goto run
wscript.exe //nologo "%~dp0Start-Arvimo-Dev.vbs"
exit /b
:run
set "PATH=%SystemRoot%\System32;%PATH%"
cd /d "%~dp0"
if not exist "_local\desktop-dev" mkdir "_local\desktop-dev"
node apps\assetvault\sketchfab-exporter-tauri\scripts\dev.mjs >> "_local\desktop-dev\dev.log" 2>&1
