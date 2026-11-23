@echo off
setlocal
cd /d "%~dp0"
set "NODE_OPTIONS="
set "NODE_PATH="
if not exist "%~dp0runtime\node.exe" (
  echo Missing bundled runtime. Extract the entire ZIP first.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0launch.mjs" %*
if errorlevel 1 (
  echo.
  echo Startup failed. Read the error above and README.txt.
  pause
  exit /b 1
)
endlocal
