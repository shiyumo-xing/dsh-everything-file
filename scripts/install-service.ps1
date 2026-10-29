# Install (or repair) the local NTFS index service.
# Run this script from an elevated PowerShell, or double-click install-service.cmd
# (which self-elevates and shows the UAC prompt).

$ErrorActionPreference = 'Stop'
$serviceName = 'dsh-mft-index'
$sourceExe = (Resolve-Path (Join-Path $PSScriptRoot '..\bin\dsh-mft-indexer.exe')).Path
$installDir = Join-Path $env:ProgramData 'dsh-mft-index'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# Copy the binary out of the plugin package: the profile's package directory is
# replaced on plugin updates, while a service must keep a stable image path.
$exe = Join-Path $installDir 'dsh-mft-indexer.exe'
Copy-Item -Path $sourceExe -Destination $exe -Force

Write-Host "Installing $serviceName"
Write-Host "  binary: $exe (copied from $sourceExe)"
Write-Host "  log:    $(Join-Path $installDir 'indexer.log')"

# Stop and remove any previous service before replacing the image.
& sc.exe stop $serviceName 2>$null | Out-Null
Start-Sleep -Milliseconds 600
& sc.exe delete $serviceName 2>$null | Out-Null
Start-Sleep -Milliseconds 400

$binPath = '"' + $exe + '" --service'
& sc.exe create $serviceName binPath= $binPath start= auto DisplayName= "DSH MFT Index" | Out-Null
& sc.exe description $serviceName "NTFS MFT index for DeepSeek Harness @file search (serves \\\\.\\pipe\\dsh-mft-index)" | Out-Null
& sc.exe failure $serviceName reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
& sc.exe start $serviceName | Out-Null
Start-Sleep -Seconds 3
& sc.exe query $serviceName

Write-Host ''
Write-Host 'The service builds the index in the background (MFT scan of every fixed NTFS volume).'
Write-Host 'Check readiness from the Harness with the mft_index_status tool, or:'
Write-Host "  Get-Content '$(Join-Path $installDir 'indexer.log')' -Tail 20"
