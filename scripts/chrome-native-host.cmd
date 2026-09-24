@echo off
setlocal
set "ROOT=%~dp0.."
if not defined LOCALAPPDATA exit /b 2
if exist "%ROOT%\dist\web\chrome-native-host.js" (
  "%ProgramFiles%\nodejs\node.exe" "%ROOT%\dist\web\chrome-native-host.js" %*
  exit /b %ERRORLEVEL%
)
node "%ROOT%\dist\web\chrome-native-host.js" %*
exit /b %ERRORLEVEL%
