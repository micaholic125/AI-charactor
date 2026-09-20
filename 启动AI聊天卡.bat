@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AI Chat Cards

node scripts/launch.mjs

pause >nul
