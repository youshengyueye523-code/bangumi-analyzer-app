@echo off
rem =====================================================================
rem  Bangumi Anime Database - Windows launcher (double-click to run)
rem
rem  What it does:
rem    0) refuse to continue when key source files are missing (external cleanup)
rem    1) switch to the project directory (folder of this file)
rem    2) start the server with the already verified corepack pnpm command
rem    3) wait until the health check passes
rem    4) open http://127.0.0.1:8787/ in the default browser
rem
rem  Notes:
rem    * the server may migrate/maintain data during startup; review before use
rem    * no token / key is stored in this file
rem    * if the service is already running, this only opens the browser
rem    * the server runs in its own window: close that window to stop it
rem    * if key source files are missing, it stops before install / build / start
rem      (guards against damage from external cleanup or accidental deletion)
rem    * this file is intentionally ASCII-only (safe on any Windows locale)
rem =====================================================================
setlocal EnableExtensions
title Bangumi Anime Database - Launcher

rem always work in the folder that contains this script
cd /d "%~dp0"

set "APP_PORT=8787"
if defined PORT set "APP_PORT=%PORT%"
set "APP_URL=http://127.0.0.1:%APP_PORT%/"
set "HEALTH_URL=http://127.0.0.1:%APP_PORT%/api/health"
rem health checks must bypass HTTP_PROXY: with a proxy env var set, curl sends the
rem loopback request to the proxy and gets 502, so the readiness wait would time out
set "NO_PROXY=localhost,127.0.0.1,::1"
set "no_proxy=%NO_PROXY%"
set "SERVER_TITLE=Bangumi Anime Database - close this window to stop"
set "WAIT_SECONDS=60"
set "LAUNCH_LOG=%~dp0data\logs\launcher.log"

echo.
echo    Bangumi Anime Database
echo    ------------------------------------------------------------
echo    Project : %CD%
echo    URL     : %APP_URL%
echo.

call :log "START  port=%APP_PORT%  url=%APP_URL%"
if not exist "package.json" goto :err_not_root

rem ---------- 0/4 worktree integrity gate (silent while the tree is complete) ----------
rem Only source files are checked here. dist\ and node_modules\ are regenerated
rem artifacts, so they must never decide whether the worktree is intact.
set "MISSING="
call :need "pnpm-workspace.yaml"
call :need "pnpm-lock.yaml"
call :need "packages\server\package.json"
call :need "packages\shared\package.json"
call :need "packages\web\package.json"
if defined MISSING goto :err_incomplete

call "%~dp0scripts\node24-env.bat"
if errorlevel 1 exit /b 1
if not defined NODE_ENV set "NODE_ENV=production"

rem ---------- 1/4 resolve pnpm (prefer the verified corepack pnpm) ----------
set "PNPM="
where corepack >nul 2>&1
if not errorlevel 1 set "PNPM=corepack pnpm"
if not defined PNPM (
  where pnpm >nul 2>&1
  if not errorlevel 1 set "PNPM=pnpm"
)
if not defined PNPM goto :err_no_pnpm
if exist "%~dp0.runtime\ba-local-v2-20261117-180040.bat" (echo    [1/4] command : installed Local v2.0.0) else (echo    [1/4] command : %PNPM% -C packages/server run start)

rem ---------- 2/4 is the service already running? ----------
call :check_running
if "%RUNNING%"=="1" goto :already_running
echo    [2/4] service is not running, starting it

call :check_port
if "%LISTENING%"=="1" goto :err_port_busy

rem small settle delay: if this file is double-clicked twice in a row, the first
rem instance may still be starting up - re-check once before starting our own copy
ping -n 2 127.0.0.1 >nul 2>&1
call :check_running
if "%RUNNING%"=="1" goto :already_running
call :check_port
if "%LISTENING%"=="1" goto :err_port_busy

rem ---------- 3/4 build output present? (only needed on first run) ----------
if exist "packages\server\dist\index.js" if exist "packages\web\dist\index.html" goto :build_ok
echo    [3/4] no build output found (first run needs one build)
echo.
set "ANSWER="
set /p "ANSWER=          build now? [Y/N] "
if /i not "%ANSWER%"=="Y" goto :err_no_build
echo.
echo          building, please wait (this can take a few minutes) ...
call %PNPM% build
if errorlevel 1 goto :err_build_failed
echo          build finished.
:build_ok
echo    [3/4] build output ok

rem ---------- 4/4 start the server in its own window ----------
echo    [4/4] starting the server ...
if "%BANGUMI_LAUNCH_FOREGROUND%"=="1" goto :foreground
if exist "%~dp0.runtime\ba-local-v2-20261117-180040.bat" (
  start "%SERVER_TITLE%" cmd /c call "%~dp0.runtime\ba-local-v2-20261117-180040.bat"
) else (
  echo [ERROR] Installed Local v2.0.0 launcher is missing.
  exit /b 1
)

call :wait_ready
call :log "RESULT ready=%READY%  elapsed=%ELAPSED%s  http_proxy=[%HTTP_PROXY%]  no_proxy=[%NO_PROXY%]"
if not "%READY%"=="1" goto :err_timeout

echo.
call :log "OPEN   browser"
echo    [OK] service is ready, opening the browser ...
if not "%BANGUMI_LAUNCH_NO_BROWSER%"=="1" start "" "%APP_URL%"
echo.
echo    Notes
echo      * the server runs in the window titled "%SERVER_TITLE%".
echo        Close that window to stop the service (or run stop-bangumi.bat).
echo      * this launcher window can be closed, the service keeps running.
echo      * startup can maintain queues, derived data and database schema.
echo.
exit /b 0

:foreground
if exist "%~dp0.runtime\ba-local-v2-20261117-180040.bat" (
  call "%~dp0.runtime\ba-local-v2-20261117-180040.bat"
) else (
  echo [ERROR] Installed Local v2.0.0 launcher is missing.
  exit /b 1
)
exit /b %errorlevel%

rem ====================== subroutines ======================

:need
rem collect one missing required source file (called, so %MISSING% re-expands)
if not exist "%~1" set "MISSING=%MISSING% %~1"
exit /b 0

:check_running
rem only a healthy /api/health response counts as "our service"
set "RUNNING=0"
set "HEALTH_FILE=%TEMP%\bangumi-analyzer-health-%APP_PORT%.tmp"
if exist "%HEALTH_FILE%" del "%HEALTH_FILE%" >nul 2>&1
where curl >nul 2>&1
if not errorlevel 1 (
  curl -s --max-time 2 --noproxy "*" -o "%HEALTH_FILE%" "%HEALTH_URL%" >nul 2>&1
  if exist "%HEALTH_FILE%" (
    findstr /i /c:"bangumi.db" "%HEALTH_FILE%" >nul 2>&1
    if not errorlevel 1 set "RUNNING=1"
    del "%HEALTH_FILE%" >nul 2>&1
  )
  exit /b 0
)
rem fallback when curl.exe is unavailable (command only, no policy change)
powershell -NoProfile -Command "try{ [System.Net.WebRequest]::DefaultWebProxy=[System.Net.WebProxy]::new(); if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%HEALTH_URL%').Content -match 'bangumi.db'){exit 0}else{exit 1} }catch{ exit 1 }" >nul 2>&1
if not errorlevel 1 set "RUNNING=1"
exit /b 0

:check_port
rem is anything listening on the port (ours or not)?
set "LISTENING=0"
netstat -ano | findstr /r /c:":%APP_PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 set "LISTENING=1"
exit /b 0

:wait_ready
set "READY=0"
set /a ELAPSED=0
echo          waiting until the service is ready (max %WAIT_SECONDS%s)
:wait_ready_loop
call :check_running
echo          .
if "%RUNNING%"=="1" (
  set "READY=1"
  exit /b 0
)
ping -n 2 127.0.0.1 >nul 2>&1
set /a ELAPSED+=1
if %ELAPSED% GEQ %WAIT_SECONDS% exit /b 0
goto :wait_ready_loop

rem ====================== results ======================

:already_running
call :log "RESULT already-running  url=%APP_URL%"
echo    [SKIP] this project's service is already running on port %APP_PORT%.
echo           no second instance is started, opening the page instead.
echo.
if not "%BANGUMI_LAUNCH_NO_BROWSER%"=="1" start "" "%APP_URL%"
exit /b 0

:err_not_root
echo    [ERROR] package.json not found - this file is not in the project root.
echo            Put it next to package.json and try again.
echo.
pause
exit /b 1

:err_incomplete
echo.
echo    [ERROR] Analyzer worktree is incomplete: required project files are missing.
echo            This usually means files were removed by an external cleanup tool,
echo            an accidental deletion, or a security product.
echo.
echo            Missing:
echo              %MISSING%
echo.
echo            Nothing was installed, built or started.
echo            Recover the files from Git first, for example:
echo               git restore --source=HEAD --worktree -- pnpm-workspace.yaml pnpm-lock.yaml packages public-demo
echo            Then run this file again.
echo.
pause
exit /b 1

:err_no_pnpm
echo    [ERROR] neither corepack nor pnpm was found.
echo            Install Node.js 24 or newer (it ships with corepack):
echo               https://nodejs.org/
echo            Then double-click this file again.
echo.
pause
exit /b 1

:err_port_busy
echo    [ERROR] port %APP_PORT% is used by another program, and it is not this project.
echo            Close that program and try again.
echo            Check with : netstat -ano ^| findstr ":%APP_PORT%"
echo.
pause
exit /b 1

:err_no_build
echo.
echo    [CANCELLED] without build output the server cannot start.
echo                You can build manually with : %PNPM% build
echo.
pause
exit /b 1

:err_build_failed
echo.
echo    [ERROR] build failed, see the output above.
echo            Common causes: no network, or dependencies not installed.
echo            Try : %PNPM% install
echo.
pause
exit /b 1

:err_timeout
call :log "RESULT timeout  elapsed=%ELAPSED%s  http_proxy=[%HTTP_PROXY%]  no_proxy=[%NO_PROXY%]"
echo.
echo    [ERROR] the service was not ready within %WAIT_SECONDS%s.
echo.
echo            No automatic second start was attempted. Inspect the existing process:
echo               %PNPM% -C packages/server run start
echo            URL : %APP_URL%
echo.
pause
exit /b 1
rem ====================== log ======================
:log
setlocal EnableExtensions
rem wmic is gone on recent Windows builds, so use the shell's own date/time
set "T=%TIME: =0%"
set "STAMP=%DATE:~0,10% %T:~0,8%"
if not exist "%~dp0data\logs" mkdir "%~dp0data\logs" >nul 2>&1
>>"%LAUNCH_LOG%" echo %STAMP%  %~1
endlocal
exit /b 0
