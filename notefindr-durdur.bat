@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  notefindr-durdur.bat - NoteFindr backend'i durdurur
REM  1) STOP bayragi (logs\backend.stop) olusturur -> restart-loop
REM     uvicorn cikinca (veya restart oncesi) YENIDEN BASLATMAZ
REM  2) uvicorn'u oldurur (iki kez: bayrak gorulmeden restart olduysa da gitsin)
REM ============================================================

echo NoteFindr backend durduruluyor...

if not exist "notefinder-backend\logs" mkdir "notefinder-backend\logs"
echo stop> "notefinder-backend\logs\backend.stop"

call :killport
ping -n 4 127.0.0.1 >nul
call :killport

echo Backend durduruldu (port 8000 serbest birakildi).
goto :eof

:killport
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
goto :eof
