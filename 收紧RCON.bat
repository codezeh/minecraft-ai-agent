@echo off
REM ============================================================
REM  Double-click this file to tighten RCON exposure.
REM  A UAC window will appear - click "Yes".
REM
REM  Why a .bat wrapper: Windows requires elevation for firewall rules,
REM  and no script can "self-elevate" without your consent.
REM  This layer is ASCII-only on purpose (cmd codepage safety);
REM  all Chinese text lives in the .ps1.
REM
REM  Chinese-path note: the script path is passed via an ENVIRONMENT
REM  VARIABLE, never baked into a PowerShell string literal.
REM  (Baking it in breaks Test-Path on non-ASCII paths; verified.)
REM ============================================================
chcp 65001 >nul
setlocal

REM %~dp0 already ends with a backslash.
set "RCON_PS1=%~dp0scripts\deny-rcon-25575-in.ps1"

if not exist "%RCON_PS1%" (
    echo [ERROR] Cannot find the script:
    echo         %RCON_PS1%
    echo.
    echo         Put this .bat in the project root, next to the scripts\ folder.
    echo.
    pause
    exit /b 1
)

echo.
echo  Requesting administrator privileges...
echo  A UAC window will appear. Click "Yes".
echo.
echo  If you click "No", nothing changes and RCON stays exposed.
echo.

powershell -NoProfile -Command "try { Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$env:RCON_PS1) -ErrorAction Stop; exit 0 } catch { Write-Host ('[INFO] Elevation cancelled or failed: ' + $_.Exception.Message); exit 1 }"

if errorlevel 1 (
    echo.
    echo  [INFO] Not elevated. Nothing was changed.
    echo.
    pause
    exit /b 1
)

echo.
echo  An elevated window opened. Read its output for the result
echo  and the three-step verification instructions.
timeout /t 4 >nul
exit /b 0
