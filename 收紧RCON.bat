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

REM ---- R6 #48 (2026-11-11): this layer used to exit 0 as soon as the
REM      elevated window was LAUNCHED. A netsh failure inside it (group
REM      policy, rule conflict, AV) was only visible in a window that closes
REM      immediately => "double-click -> exit 0" proved nothing.
REM      Now: -Wait -PassThru, then propagate the child's REAL exit code.
REM      Exit codes of the child: 0 = rule installed AND read back OK,
REM      1 = could not install / read-back shape wrong.
powershell -NoProfile -Command "try { $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$env:RCON_PS1) -ErrorAction Stop; exit $p.ExitCode } catch { Write-Host ('[INFO] Elevation cancelled or failed: ' + $_.Exception.Message); exit 2 }"

set "RC=%ERRORLEVEL%"

if "%RC%"=="2" (
    echo.
    echo  [INFO] Not elevated. Nothing was changed.
    echo.
    pause
    exit /b 2
)
if not "%RC%"=="0" (
    echo.
    echo  [ERROR] The elevated run FAILED ^(exit %RC%^): RCON may still be exposed.
    echo          Read the elevated window output above, then run the self-check:
    echo          powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deny-rcon-25575-in.ps1 -Verify
    echo.
    pause
    exit /b %RC%
)

echo.
echo  Done. The elevated run verified the rule by reading it back:
echo  inbound / Block / TCP / local port 25575 / enabled.
echo  Self-check (no admin needed): scripts\deny-rcon-25575-in.ps1 -Verify
exit /b 0
