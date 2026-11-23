@echo off
setlocal EnableExtensions
cd /d "%~dp0"
call "%~dp0scripts\node24-env.bat"
if errorlevel 1 exit /b 1
echo Node 24.22.1 project shell. No service has been started.
echo Use node, corepack and pnpm here; exit returns to the original environment.
cmd /k
