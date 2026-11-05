@echo off
setlocal
title MC AI Panel - Start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-panel.ps1"
if errorlevel 1 pause
exit /b 0
