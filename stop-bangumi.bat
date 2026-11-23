@echo off
rem =====================================================================
rem  Bangumi Anime Database - stop the local service
rem
rem  Stops the running local server process only.
rem  The database (data/bangumi.db) is never deleted or modified.
rem  Closing the server window has the same effect.
rem  This file is intentionally ASCII-only (safe on any Windows locale).
rem =====================================================================
setlocal EnableExtensions
title Bangumi Anime Database - Stop service

cd /d "%~dp0"

set "APP_PORT=8787"
if defined PORT set "APP_PORT=%PORT%"
set "HEALTH_URL=http://127.0.0.1:%APP_PORT%/api/health"

echo.
echo    Stop Bangumi Anime Database service
echo    ------------------------------------------------------------
echo.

call :check_running
if not "%RUNNING%"=="1" goto :not_running

rem pick the PID that listens on the port
set "TARGET_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%APP_PORT% " ^| findstr "LISTENING"') do set "TARGET_PID=%%p"
if not defined TARGET_PID goto :not_running

echo    Service is running (PID %TARGET_PID%).
echo    Stopping does not affect the database or your synced data.
echo.
set "ANSWER="
set /p "ANSWER=    Stop it now? [Y/N] "
if /i not "%ANSWER%"=="Y" goto :cancelled

echo.
echo    stopping process %TARGET_PID% ...
taskkill /PID %TARGET_PID% /T >nul 2>&1
ping -n 3 127.0.0.1 >nul 2>&1

call :check_port
if "%LISTENING%"=="1" (
  echo    process did not exit, forcing ...
  taskkill /PID %TARGET_PID% /T /F >nul 2>&1
  ping -n 3 127.0.0.1 >nul 2>&1
)

call :check_port
if "%LISTENING%"=="1" goto :still_running

echo.
echo    [OK] service stopped. The database file is untouched.
echo.
pause
exit /b 0

rem ====================== subroutines ======================

:check_running
rem only a healthy /api/health response counts as "our service"
set "RUNNING=0"
set "HEALTH_FILE=%TEMP%\bangumi-analyzer-health-%APP_PORT%.tmp"
if exist "%HEALTH_FILE%" del "%HEALTH_FILE%" >nul 2>&1
where curl >nul 2>&1
if not errorlevel 1 (
  curl -s --max-time 2 -o "%HEALTH_FILE%" "%HEALTH_URL%" >nul 2>&1
  if exist "%HEALTH_FILE%" (
    findstr /i /c:"bangumi.db" "%HEALTH_FILE%" >nul 2>&1
    if not errorlevel 1 set "RUNNING=1"
    del "%HEALTH_FILE%" >nul 2>&1
  )
  exit /b 0
)
powershell -NoProfile -Command "try{ if((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%HEALTH_URL%').Content -match 'bangumi.db'){exit 0}else{exit 1} }catch{ exit 1 }" >nul 2>&1
if not errorlevel 1 set "RUNNING=1"
exit /b 0

:check_port
set "LISTENING=0"
netstat -ano | findstr /r /c:":%APP_PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 set "LISTENING=1"
exit /b 0

rem ====================== results ======================

:not_running
echo    No service of this project is running on port %APP_PORT%.
echo.
pause
exit /b 0

:cancelled
echo.
echo    Cancelled, the service keeps running.
echo.
pause
exit /b 0

:still_running
echo.
echo    [WARN] process %TARGET_PID% is still running, please close its window manually.
echo.
pause
exit /b 1
