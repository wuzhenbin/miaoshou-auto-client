@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-client-native.ps1" -Source "%~dp0" %*
if errorlevel 1 pause
