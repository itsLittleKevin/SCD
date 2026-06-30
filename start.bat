@echo off
setlocal
cd /d "%~dp0"

echo Starting SCD API...
start "SCD API" cmd /c "npm run dev:api"

echo Waiting for API warmup...
timeout /t 2 /nobreak >nul

echo Starting SCD UI...
start "SCD UI" cmd /c "npm run dev:ui"

echo SCD started. Open http://127.0.0.1:5173 if it does not open automatically.
exit /b 0
