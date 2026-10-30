# Sign the Windows binaries with Authenticode.
#
# This script is used by the release workflow when a code-signing certificate is
# configured. It imports the PFX into the current user's certificate store,
# signs every listed executable with SHA-256 and a timestamp, verifies each
# signature, and removes the imported certificate again.
#
# Usage:
#   ./scripts/sign-windows.ps1 `
#     -Files bin/dsh-mft-indexer.exe `
#     -PfxPath .\codesign.pfx `
#     -PfxPassword (Read-Host -AsSecureString "PFX password") `
#     -RequireValid
#
# A self-signed certificate can be used for local testing, but it will not
# remove Windows SmartScreen warnings for other users. Use a publicly trusted
# code-signing certificate for releases.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]] $Files,

    [Parameter(Mandatory = $true)]
    [string] $PfxPath,

    [SecureString] $PfxPassword,

    [string] $TimestampServer = 'http://timestamp.digicert.com',

    [switch] $NoTimestamp,

    [switch] $RequireValid
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $PfxPath)) {
    throw "PFX file not found: $PfxPath"
}

$resolvedPfx = (Resolve-Path -LiteralPath $PfxPath).Path
$imported = $null
$failed = 0

try {
    $importArgs = @{
        FilePath          = $resolvedPfx
        CertStoreLocation = 'Cert:\CurrentUser\My'
    }
    if ($PfxPassword) { $importArgs.Password = $PfxPassword }
    $imported = Import-PfxCertificate @importArgs
    Write-Host "Signing certificate: $($imported.Subject)"
    Write-Host "Thumbprint:          $($imported.Thumbprint)"

    foreach ($file in $Files) {
        if (-not (Test-Path -LiteralPath $file)) { throw "File not found: $file" }
        $path = (Resolve-Path -LiteralPath $file).Path
        $signArgs = @{
            FilePath     = $path
            Certificate  = $imported
            HashAlgorithm = 'SHA256'
        }
        if (-not $NoTimestamp) { $signArgs.TimestampServer = $TimestampServer }

        Set-AuthenticodeSignature @signArgs | Out-Null
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '(no signer)' }
        Write-Host ("{0}: {1} | {2}" -f (Split-Path -Leaf $path), $signature.Status, $subject)

        if ($signature.Status -ne 'Valid') {
            $failed++
            if ($RequireValid) {
                throw "Signature is not trusted for $path ($($signature.Status))."
            }
            Write-Warning "Signature for $(Split-Path -Leaf $path) is $($signature.Status); a trusted certificate is required for a clean release."
        }
    }
} finally {
    if ($imported) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($imported.Thumbprint)" -Force -ErrorAction SilentlyContinue
    }
}

if ($failed -gt 0) {
    Write-Host "Signed $($Files.Count) file(s), $failed with a non-Valid trust status."
} else {
    Write-Host "Signed $($Files.Count) file(s); all signatures are Valid."
}
