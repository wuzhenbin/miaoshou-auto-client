@echo off
cd /d "%~dp0"
echo Miaoshou client starting...
if not exist "%~dp0runtime\node.exe" (
  echo Missing runtime\node.exe. Extract the entire ZIP before starting.
  pause
  exit /b 1
)
if not exist "%~dp0launcher.mjs" (
  echo Missing launcher.mjs. Extract the entire ZIP before starting.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0launcher.mjs"
set "result=%ERRORLEVEL%"
echo.
echo Client stopped with exit code %result%. Press any key to close.
pause >nul
exit /b %result%
