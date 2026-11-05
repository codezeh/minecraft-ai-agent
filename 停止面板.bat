@echo off
setlocal
title MC AI Panel - Stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-panel.ps1"
if errorlevel 1 pause
exit /b 0
