@echo off
chcp 65001 >nul
title JD - IphoneWall
cd /d "%~dp0"
echo ==============================================
echo    JD - IphoneWall - spustam stranku
echo ==============================================

rem Este nie je nainstalovane - najprv instalacia
where node >nul 2>nul || goto install
if not exist "bin\ios.exe" goto install
goto run

:install
echo   Chyba instalacia - spustam install-windows.bat...
call "%~dp0install-windows.bat"
exit /b

:run
rem Zastav stary server a stare procesy z minuleho spustenia
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do taskkill /f /pid %%p >nul 2>nul
taskkill /f /im ios.exe >nul 2>nul
taskkill /f /im cloudflared.exe >nul 2>nul

rem Tunel pre iOS 17 a novsie (bezi v malom samostatnom okne - nezatvaraj ho)
start "go-ios tunel" /min "bin\ios.exe" tunnel start --userspace

echo   [OK] Pripoj iPhony kablom a odomkni ich. Stranka sa otvori sama.
echo   Toto okno NECHAJ otvorene - zatvorenim sa stranka vypne.
echo.
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"

:loop
node server.js
if "%errorlevel%"=="75" (
  echo.
  echo   Stranka sa aktualizovala - spustam novu verziu...
  timeout /t 2 >nul
  goto loop
)
taskkill /fi "WINDOWTITLE eq go-ios tunel*" >nul 2>nul
pause
