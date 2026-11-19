@echo off
setlocal

cd /d "%~dp0"

echo [1/3] Installing locked dependencies...
call npm ci
if errorlevel 1 goto :error

echo [2/3] Running checks...
call npm run lint
if errorlevel 1 goto :error
call npm test
if errorlevel 1 goto :error
echo [3/3] Building the Windows setup...
call npm run build:desktop
if errorlevel 1 goto :error

echo.
echo ========================================
echo Windows setup is ready. Open the versioned Installr-Setup file in release.
echo ========================================
goto :eof

:error
echo Build failed with exit code %errorlevel%.
exit /b %errorlevel%
