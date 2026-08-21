@echo off
chcp 65001 >nul
title NoteFindr Başlatılıyor

echo ==================================================
echo               NoteFindr Başlatılıyor
echo ==================================================
echo.
echo Bu bilgisayarın IP adres(ler)i (telefon bağlantısı için):
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=1" %%b in ("%%a") do echo      http://%%b:8000
)
echo.
echo HATIRLATMA: src\constants\index.js icindeki API.BASE_URL
echo bu IP ile AYNI olmali (port 8000). Telefon ve PC ayni Wi-Fi'da olmali.
echo    ornek:  BASE_URL: "http://192.168.1.107:8000"
echo.
echo --------------------------------------------------
echo Eski surecler temizleniyor (port 8000 + 8081)...
echo --------------------------------------------------
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8081 ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
echo Eski surecler temizlendi.
echo.

echo --------------------------------------------------
echo Backend ve Expo ayri pencerelerde aciliyor...
echo --------------------------------------------------

start "NoteFindr Backend" cmd /k "cd /d C:\Users\90553\notefinder-mobile\notefinder-backend && set PATH=%PATH%;C:\Users\90553\Downloads\lilypond-2.26.0-mingw-x86_64\lilypond-2.26.0\bin && call venv\Scripts\activate.bat && uvicorn main:app --reload --host 0.0.0.0 --port 8000"

start "NoteFindr Expo" cmd /k "cd /d C:\Users\90553\notefinder-mobile && npx expo start"

echo.
echo Iki pencere acildi:
echo   - "NoteFindr Backend"  (uvicorn, http://0.0.0.0:8000)
echo   - "NoteFindr Expo"     (Expo - telefonda Expo Go ile QR okut)
echo.
echo Bu pencereyi kapatabilirsin; diger iki pencere acik kalir.
echo.
pause
