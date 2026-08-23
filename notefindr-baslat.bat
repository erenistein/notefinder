@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ============================================================
REM  notefindr-baslat.bat  - NoteFindr backend'i KALICI servis
REM  * LilyPond bin'i PATH'e ekler (PDF uretimi)
REM  * uvicorn'u 0.0.0.0:8000'de baslatir, log: notefinder-backend\logs\backend.log
REM  * COKERSE 5 sn sonra otomatik yeniden baslatir (sonsuz dongu)
REM  * ayri "NoteFindr Backend" penceresinde calisir
REM  Durdurmak: notefindr-durdur.bat (logs\backend.stop bayragi ile)
REM  (Expo DAHIL DEGIL; gelistirirken ayrica:  npx expo start)
REM ============================================================

if /i "%~1"=="loop" goto loop

REM --- Ana giris: dongu modunu AYRI pencerede baslat, hemen don ---
start "NoteFindr Backend" cmd /c call "%~f0" loop
echo NoteFindr backend KALICI servis olarak baslatildi (ayri pencere, port 8000).
echo   Loglar : notefinder-backend\logs\backend.log
echo   Durdur : notefindr-durdur.bat
exit /b 0

REM --- Dongu modu (ayri pencerede): coker ise 5 sn sonra yeniden; STOP bayraginda cikar ---
:loop
cd /d "%~dp0notefinder-backend"
if not exist "logs" mkdir "logs"
if exist "logs\backend.stop" del "logs\backend.stop" >nul 2>&1
set "PATH=C:\Users\90553\Downloads\lilypond-2.26.0-mingw-x86_64\lilypond-2.26.0\bin;%PATH%"
cls
echo ==================================================
echo   NoteFindr Backend - KALICI servis (port 8000)
echo ==================================================
echo   Loglar : notefinder-backend\logs\backend.log
echo   Durdur : notefindr-durdur.bat
echo.
echo Telefon baglantisi icin bu PC'nin IP adres(ler)i:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=1" %%b in ("%%a") do echo      http://%%b:8000
)
echo (src\constants\index.js -^> API.BASE_URL bununla ayni + :8000 olmali)
echo.
:restart
if exist "logs\backend.stop" ( del "logs\backend.stop" >nul 2>&1 & goto stopped )
echo [%date% %time%] backend baslatiliyor >> "logs\backend.log"
echo [%date% %time%] backend calisiyor... (durdurmak: notefindr-durdur.bat)
"venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8000 >> "logs\backend.log" 2>&1
if exist "logs\backend.stop" ( del "logs\backend.stop" >nul 2>&1 & goto stopped )
echo [%date% %time%] backend durdu (cikis kodu %errorlevel%), 5 sn sonra yeniden baslatiliyor. >> "logs\backend.log"
echo [%date% %time%] backend durdu, 5 sn sonra yeniden baslatiliyor...
ping -n 6 127.0.0.1 >nul
goto restart

:stopped
echo [%date% %time%] durdurma istegi alindi, servis sonlandirildi. >> "logs\backend.log"
echo Backend durduruldu (durdurma istegi). Bu pencere kapanabilir.
