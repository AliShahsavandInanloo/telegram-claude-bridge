@echo off
cd /d "%~dp0"
echo Starting Claude bridge (Ctrl+C to stop)...
node bridge.js
pause
