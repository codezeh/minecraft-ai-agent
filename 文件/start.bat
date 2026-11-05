@echo off
setlocal

set "ROOT=%~dp0"
set "JAVA=%ROOT%.tools\jdk-21.0.12.1+1\bin\java.exe"
set "NODE=D:\Node\node.exe"

echo ================================================
echo   Mindcraft launcher
echo ================================================
echo.

if not exist "%JAVA%" (
    echo [ERROR] JDK not found: %JAVA%
    pause
    exit /b 1
)
if not exist "%NODE%" (
    echo [ERROR] Node not found: %NODE%
    pause
    exit /b 1
)
if not exist "%ROOT%server\server.jar" (
    echo [ERROR] server.jar not found
    pause
    exit /b 1
)

echo [1/3] Starting Minecraft server (1.21.8, offline, port 25565) ...
start "MC Server" /D "%ROOT%server" "%JAVA%" -Xms1G -Xmx2G -XX:+UseG1GC -jar server.jar nogui

echo       Waiting for server to boot ...
timeout /t 25 /nobreak >nul

echo [2/3] Starting Mindcraft ...
start "Mindcraft" /D "%ROOT%mindcraft" "%NODE%" main.js

echo       Waiting for MindServer (8080) ...
timeout /t 12 /nobreak >nul

echo [3/3] Starting Web panel ...
start "WebPanel" /D "%ROOT%web" "%NODE%" "%ROOT%web\node_modules\vite\bin\vite.js"

echo.
echo Started.
echo   Panel:      http://localhost:5173
echo   Old console http://localhost:8080
echo Close the windows to stop.
echo.
pause
