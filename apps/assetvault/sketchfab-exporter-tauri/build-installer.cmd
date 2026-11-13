@echo off
chcp 65001 >nul
call "%~dp0..\..\..\Build-Arvimo.cmd"
exit /b %errorlevel%
