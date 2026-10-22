@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is required. Install from https://nodejs.org/ & pause & exit /b 1)
if "%PORT%"=="" set "PORT=4337"
if "%PROJECTS%"=="" set "PROJECTS=%USERPROFILE%\blackboard-projects"
if not exist "%PROJECTS%" mkdir "%PROJECTS%"
node bin\blackboard.js serve --projects "%PROJECTS%" --port %PORT% --open
