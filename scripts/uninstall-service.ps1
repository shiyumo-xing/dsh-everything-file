# Stop and remove the local NTFS index service.
# Run from an elevated PowerShell.

$ErrorActionPreference = 'Continue'
$serviceName = 'dsh-mft-index'
& sc.exe stop $serviceName | Out-Null
Start-Sleep -Seconds 1
& sc.exe delete $serviceName | Out-Null
Write-Host "Removed $serviceName (if it existed)."
