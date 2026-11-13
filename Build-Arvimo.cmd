@echo off
chcp 65001 >nul
cd /d "%~dp0"
call npm --prefix apps\assetvault\sketchfab-exporter-tauri run build
if errorlevel 1 exit /b 1
echo.
echo Arvimo 安装包已生成：%~dp0dist
pause
