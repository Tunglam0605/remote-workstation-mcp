@echo off
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" (
  echo Windows PowerShell was not found.
  pause
  exit /b 1
)

echo Remote Workstation MCP - verified one-time installer
echo.
"%PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
 "$ErrorActionPreference='Stop';" ^
 "$base='https://github.com/Tunglam0605/remote-workstation-mcp/releases/latest/download';" ^
 "$dir=Join-Path ([IO.Path]::GetTempPath()) ('rwmcp-bootstrap-'+[Guid]::NewGuid().ToString('N'));" ^
 "New-Item -ItemType Directory -Force -Path $dir ^| Out-Null;" ^
 "try {" ^
 "  $installer=Join-Path $dir 'install-windows.ps1';" ^
 "  $sums=Join-Path $dir 'SHA256SUMS.txt';" ^
 "  Write-Host 'Downloading verified installer...' -ForegroundColor Cyan;" ^
 "  Invoke-WebRequest -UseBasicParsing -Uri ($base+'/install-windows.ps1') -OutFile $installer;" ^
 "  Invoke-WebRequest -UseBasicParsing -Uri ($base+'/SHA256SUMS.txt') -OutFile $sums;" ^
 "  $line=Get-Content $sums ^| Where-Object { $_ -match 'install-windows\.ps1\s*$' } ^| Select-Object -First 1;" ^
 "  if(-not $line -or $line -notmatch '^([0-9a-fA-F]{64})\s+'){throw 'Installer checksum is missing from SHA256SUMS.txt.'};" ^
 "  $expected=$Matches[1].ToLowerInvariant();" ^
 "  $actual=(Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant();" ^
 "  if($actual -ne $expected){throw ('Installer SHA-256 mismatch. Expected '+$expected+' but got '+$actual)};" ^
 "  Write-Host 'Installer verified. Starting setup...' -ForegroundColor Green;" ^
 "  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $installer;" ^
 "  if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}" ^
 "} finally { Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue }"

if errorlevel 1 (
  echo.
  echo Installation did not complete successfully.
  pause
  exit /b 1
)

echo.
echo Remote Workstation MCP installation finished.
timeout /t 3 /nobreak >nul
exit /b 0
