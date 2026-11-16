@echo off
setlocal
pushd "%~dp0"
"runtime\node.exe" "Launch-Honeymoon.mjs" --tailscale %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
popd
exit /b %result%
