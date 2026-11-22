@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-client-native.ps1" %*
if errorlevel 1 pause
