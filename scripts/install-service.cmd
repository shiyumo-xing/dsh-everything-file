@echo off
setlocal
set "SCRIPT=%~dp0install-service.ps1"
echo Requesting administrator rights to install the DSH MFT index service...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File \"' + '%SCRIPT%' + '\"') -Wait"
echo.
pause
