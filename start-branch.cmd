@echo off
rem Slothbench Branch (the printer program) - see README.md. Keeps running; close this window to stop it.
cd /d "%~dp0"
node slothbench-branch.js
pause
