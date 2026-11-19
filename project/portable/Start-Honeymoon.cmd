@echo off
setlocal
title Lilium Moonlight
pushd "%~dp0"
"runtime\node.exe" "Launch-Honeymoon.mjs" %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
popd
exit /b %result%
