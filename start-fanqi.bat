@echo off
cd /d "%~dp0"
start "翻棋" /MIN python server.py
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:8787/"
