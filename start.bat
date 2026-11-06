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
    echo         Install Node.js 22 LTS or newer from https://nodejs.org/
    echo         ^(this project imports node:sqlite at top level, requires Node 22+^)
    echo         or place a portable copy at .tools\node\node.exe
    pause
    exit /b 1
)
echo   Node.js : %NODE%

REM ---------- Node 版本闸（OPS-006）----------
REM 本仓顶层导入 node:sqlite（Node 22+ 才内置），按旧文档装 18/20 会在加载阶段直接崩。
REM 这里提前给出明确提示，而不是让用户看一段看不懂的 ERR_UNKNOWN_BUILTIN_MODULE。
REM ★ 必须用延迟展开：NODE_MAJOR 是在 for 里赋值的，而 cmd 会在**整块解析时**
REM   就把 %NODE_MAJOR% 展开（那时还是空）⇒ 直接语法错 "22 was unexpected"。
REM ★ 用 `node -v` 而不是 `-p`：后者带引号嵌在 for /f 的单引号里会被 cmd 拆坏
REM   （实测拿到的是 `' "node -p "process` 这种垃圾）。`v24.16.0` 按 v/. 切分后 token1 = 24。
setlocal EnableDelayedExpansion
set "NODE_MAJOR="
for /f "tokens=1 delims=v." %%v in ('"%NODE%" -v 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
    echo [WARN] Could not read Node version ^(continuing^).
) else if !NODE_MAJOR! LSS 22 (
    echo [ERROR] Node.js !NODE_MAJOR!.x is too old. This project requires Node.js 22 or newer.
    echo         Why: src/agent/library/terrain3d.js and board_store.js import node:sqlite,
    echo         which is only built into Node 22+. Using 18/20 fails at load time.
    echo         Run "%NODE%" -v to see the current version.
    pause
    exit /b 1
)
endlocal

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
    echo [WARN] mindcraft\node_modules missing. Installing dependencies ...
    pushd "%ROOT%mindcraft"
    REM ★ F-DEP-103 / F-REG-002（2026-11-06 终审 R3-3 指出；用户批准方案②）：
    REM   package-lock.json 被 .gitignore 忽略且从未入库 => 全新 clone 必然没有 lock，
    REM   而 npm ci 的硬性前提就是"存在 lock" => 在全新 clone 上必失败 =>
    REM   F-DEP-005 那条"失败即中止"在 clone 场景反而变成负收益（能装变成装不上）。
    REM   处置：有 lock 走 npm ci（可复现，首选）；无 lock 降级 npm install 并明确告警。
    REM   注意：%ERRORLEVEL% 在括号块内不即时更新，故用 if errorlevel 1（运行期求值）。
    if exist package-lock.json (
        echo [WARN] Running npm ci (strict, per lock) ...
        call npm ci
        if errorlevel 1 (
            echo [ERROR] npm ci failed - do NOT use --ignore-scripts, it silently drops patches/.
            echo [ERROR] Fix the node_modules / package-lock.json mismatch, then run this file again.
            popd
            pause
            exit /b 1
        )
    ) else (
        echo [WARN] package-lock.json NOT found (this repo does not track its lock - see F-DEP-103).
        echo [WARN] Falling back to npm install: it works, but versions are NOT reproducible.
        echo [WARN] For reproducibility: commit the lock, or drop a trusted lock into mindcraft\.
        call npm install
        if errorlevel 1 (
            echo [ERROR] npm install failed - do NOT use --ignore-scripts, it silently drops patches/.
            echo [ERROR] Fix node_modules / network / registry, then run this file again.
            popd
            pause
            exit /b 1
        )
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
REM F-RT-002：这里**曾经**建议用户设 MINDSERVER_PRINT_TOKEN=1 —— 但本脚本的 stdout 会被
REM start-panel.ps1 重定向进 logs\, 一旦照做, 完整 token 就落盘, 等于把 F-SEC-205 的洞重新打开。
REM 现在 mindserver 在"stdout 不是终端"时会忽略该开关；这里也不再推荐它。
echo   NOTE: do not use MINDSERVER_PRINT_TOKEN here (stdout is redirected; token would land in logs).
echo Close both windows to stop.
echo.
pause
