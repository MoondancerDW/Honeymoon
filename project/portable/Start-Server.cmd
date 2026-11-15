@echo off
call "%~dp0Start-Honeymoon.cmd" --lan --no-browser %*
exit /b %errorlevel%
