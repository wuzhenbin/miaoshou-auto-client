@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1"
set "result=%ERRORLEVEL%"
echo.
echo Client exited. Press any key to close this window.
pause >nul
exit /b %result%
