@echo off
cd /d "%~dp0app"
node.exe local\run.mjs --production --open %*
if errorlevel 1 pause
