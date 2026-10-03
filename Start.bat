@echo off
setlocal
cd /d "%~dp0"
title Qingxiu local server - close this window to stop

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY (
  echo Python 3 not found. Please install Python 3 first: https://www.python.org/downloads/
  pause
  exit /b 1
)

rem Pick a currently free loopback port.
for /f "usebackq delims=" %%p in (`%PY% -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"`) do set "PORT=%%p"
if not defined PORT (
  echo Failed to allocate a local port.
  pause
  exit /b 1
)

set "URL=http://127.0.0.1:%PORT%/"
echo Qingxiu is running at %URL%
echo Your default browser will open automatically. Close this window when done.
echo.

rem Start the browser after the HTTP server has had a moment to bind.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 700; Start-Process '%URL%'"

%PY% -m http.server %PORT% --bind 127.0.0.1
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo Local server exited with code %RC%.
  pause
)
exit /b %RC%
