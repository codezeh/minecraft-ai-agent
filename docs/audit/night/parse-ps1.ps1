$ErrorActionPreference = 'Continue'
# 不写中文字面量：从脚本自身位置往上找 scripts\start-panel.ps1
$p = Join-Path $PSScriptRoot '..\..\..\scripts\start-panel.ps1'
if (-not (Test-Path $p)) { Write-Output ("NOT_FOUND: " + (Resolve-Path $PSScriptRoot).Path); exit 1 }
$full = (Resolve-Path $p).Path
$tokens = $null
$errs = $null
[System.Management.Automation.Language.Parser]::ParseFile($full, [ref]$tokens, [ref]$errs) | Out-Null
if ($errs.Count -eq 0) {
    Write-Output 'SYNTAX_OK'
} else {
    Write-Output ("SYNTAX_ERRORS: " + $errs.Count)
    $errs | Select-Object -First 6 | ForEach-Object {
        Write-Output ("  line " + $_.Extent.StartLineNumber + ": " + $_.Message)
    }
}
