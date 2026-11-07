@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1"
set "result=%ERRORLEVEL%"
echo.
echo 客户端已退出，按任意键关闭窗口。
pause >nul
exit /b %result%
