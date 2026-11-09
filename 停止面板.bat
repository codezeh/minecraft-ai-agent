@echo off
setlocal
title MC AI Panel - Stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-panel.ps1"
if not errorlevel 1 exit /b 0
set "RC=%errorlevel%"
pause
exit /b %RC%
