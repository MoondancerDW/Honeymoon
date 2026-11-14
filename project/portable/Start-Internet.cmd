@echo off
call "%~dp0Start-Honeymoon.cmd" --internet %*
exit /b %errorlevel%
