@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

REM ============================================================
REM   Minecraft AI launcher
REM   自动探测 Node.js 与 Java，找不到才报错。
REM   需要把本文件放在项目根目录（与 server\ 和 mindcraft\ 同级）。
REM ============================================================

set "ROOT=%~dp0"

echo ================================================
echo   Minecraft AI launcher
echo ================================================
echo.

REM ---------- 定位 Node.js ----------
set "NODE="
if exist "%ROOT%.tools\node\node.exe" set "NODE=%ROOT%.tools\node\node.exe"
if not defined NODE (
    for /f "delims=" %%i in ('where node 2^>nul') do (
        if not defined NODE set "NODE=%%i"
    )
)
if not defined NODE (
    echo [ERROR] Node.js not found.
    echo         Install Node.js 18/20/22 LTS from https://nodejs.org/
    echo         or place a portable copy at .tools\node\node.exe
    pause
    exit /b 1
)
echo   Node.js : %NODE%

REM ---------- 定位 Java ----------
set "JAVA="
if exist "%ROOT%.tools\jdk-21.0.12.1+1\bin\java.exe" set "JAVA=%ROOT%.tools\jdk-21.0.12.1+1\bin\java.exe"
if not defined JAVA (
    for /d %%d in ("%ROOT%.tools\jdk-*") do (
        if not defined JAVA if exist "%%d\bin\java.exe" set "JAVA=%%d\bin\java.exe"
    )
)
if not defined JAVA (
    for /f "delims=" %%i in ('where java 2^>nul') do (
        if not defined JAVA set "JAVA=%%i"
    )
)
if not defined JAVA (
    echo [ERROR] Java 21 not found.
    echo         Minecraft 1.21.8 needs Java 21+. Download from https://adoptium.net/
    echo         or place a portable JDK under .tools\jdk-*\bin\java.exe
    pause
    exit /b 1
)
echo   Java    : %JAVA%

REM ---------- 检查服务端 ----------
if not exist "%ROOT%server\server.jar" (
    echo [ERROR] server\server.jar not found.
    echo         Put the Paper server jar there, or skip the server and just run mindcraft.
    pause
    exit /b 1
)
REM ---------- 检查 mindcraft ----------
if not exist "%ROOT%mindcraft\main.js" (
    echo [ERROR] mindcraft\main.js not found.
    pause
    exit /b 1
)
REM ---------- F-DEP-004 D1（review-patch-integrity.md）：先验补丁内容，再安装 ----------
REM 为什么必须先验：npm ci 会触发 postinstall -> patch-package 把 patches/ 套进 node_modules。
REM 如果被投毒的补丁已经套进去再检查，等于"先执行、后审计"。这里只验内容（--no-version-check，
REM 因为此刻可能还没有 node_modules），验不过就直接不装、不启动。
REM 这段**不在** if not exist node_modules 里 —— 每次启动都验，防止被投毒的 node_modules 直接复用。
pushd "%ROOT%mindcraft"
if exist tools\patch_integrity.mjs (
    node tools\patch_integrity.mjs --no-version-check
    if errorlevel 1 (
        echo [ERROR] patch integrity FAILED - patches/ may be tampered or missing. Aborting BEFORE install.
        echo [ERROR] Inspect patches/ and patches/SHA256SUMS; do not just rebuild the baseline.
        popd
        pause
        exit /b 1
    )
)
popd

if not exist "%ROOT%mindcraft\node_modules" (
    echo [WARN] mindcraft\node_modules missing. Running npm ci first (strict, per lock) ...
    pushd "%ROOT%mindcraft"
    call npm ci
    if errorlevel 1 (
        echo [ERROR] npm ci failed - do NOT use --ignore-scripts, it silently drops patches/.
        echo [ERROR] Fix the node_modules / package-lock.json mismatch, then run this file again.
        popd
        pause
        exit /b 1
    )
    if exist tools\patch_integrity.mjs (
        node tools\patch_integrity.mjs
        if errorlevel 1 (
            echo [ERROR] patch integrity check failed AFTER install - patches/ drifted or not applied. Aborting.
            popd
            pause
            exit /b 1
        )
    )
    popd
)

echo.
echo [1/2] Starting Minecraft server (offline, port 25565) ...
start "MC Server" /D "%ROOT%server" "%JAVA%" -Xms1G -Xmx2G -XX:+UseG1GC -jar server.jar nogui

echo       Waiting for the server to boot (25s) ...
timeout /t 25 /nobreak >nul

echo [2/2] Starting Mindcraft ...
start "Mindcraft" /D "%ROOT%mindcraft" "%NODE%" main.js

echo.
echo Started. Web console: http://localhost:8080
REM F-REG-001（2026-11-06）：token 已不再打印到本窗口/日志（F-SEC-205 起只打指纹），
REM 浏览器需要 ?token= 才能建立 socket 握手。指到实际取用位置，否则用 start.bat 的人无路可走。
echo   Panel needs a token. Read it from: mindcraft\.mindserver-token
echo   Then open: http://localhost:8080/?token=^<the value in that file^>
echo   (Or set MINDSERVER_PRINT_TOKEN=1 before starting to print it once.)
echo Close both windows to stop.
echo.
pause
