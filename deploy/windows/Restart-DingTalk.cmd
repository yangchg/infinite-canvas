@echo off
title Restart DingTalk Notification Service
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restart-DingTalk.ps1"
pause
