@echo off
rem Project-local environment only. CALL this file from cmd.exe.
setlocal EnableExtensions
for %%I in ("%~dp0..\.runtime") do set "BA_RUNTIME=%%~fI"
set "BA_NODE=%BA_RUNTIME%\node-v24.22.1-win-x64\node.exe"
if not exist "%BA_NODE%" goto :missing
if not exist "%BA_RUNTIME%\shims\pnpm.cmd" goto :missing
if not exist "%BA_RUNTIME%\corepack-home\v1\pnpm\11.19.0\bin\pnpm.mjs" goto :missing
set "BA_VERSION="
for /f "delims=" %%V in ('"%BA_NODE%" --version') do set "BA_VERSION=%%V"
if not "%BA_VERSION%"=="v24.22.1" (
  echo [ERROR] Expected Node v24.22.1, found %BA_VERSION%.
  exit /b 1
)
set "BA_PNPM_VERSION="
for /f "delims=" %%V in ('call "%BA_RUNTIME%\shims\pnpm.cmd" --version') do set "BA_PNPM_VERSION=%%V"
if not "%BA_PNPM_VERSION%"=="11.19.0" (
  echo [ERROR] Expected pnpm 11.19.0, found %BA_PNPM_VERSION%.
  exit /b 1
)
endlocal & set "BANGUMI_RUNTIME_ROOT=%BA_RUNTIME%" & set "PATH=%BA_RUNTIME%\shims;%BA_RUNTIME%\node-v24.22.1-win-x64;%PATH%" & set "COREPACK_HOME=%BA_RUNTIME%\corepack-home" & set "COREPACK_ENABLE_NETWORK=0" & set "COREPACK_ENABLE_AUTO_PIN=0" & set "COREPACK_DEFAULT_TO_LATEST=0" & set "pnpm_config_verify_deps_before_run=warn"
exit /b 0
:missing
echo [ERROR] Project Node 24.22.1 / pnpm 11.19.0 environment is missing.
echo         No fallback to global Node or Codex runtime was attempted.
exit /b 1
