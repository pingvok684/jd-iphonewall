@echo off
chcp 65001 >nul
title JD Phone Studio - instalacia
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
