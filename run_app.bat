@echo off
title Alright TV Downloader
cd /d "%~dp0"
echo ========================================================
echo         ALRIGHT TV AUTOMATED DOWNLOADER WEB APP
echo ========================================================
echo.
echo Starting backend server on http://localhost:3030...
start "" http://localhost:3030
"D:\node.exe" server.js
pause
