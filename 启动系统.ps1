$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$minimumNodeVersion = [version]"22.13.0"
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin"
$bundledNodeExe = Join-Path $bundledNode "node.exe"

function Get-CurrentNodeVersion {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        return $null
    }

    try {
        return [version]((& node --version).TrimStart("v"))
    } catch {
        return $null
    }
}

$nodeVersion = Get-CurrentNodeVersion
if ((-not $nodeVersion -or $nodeVersion -lt $minimumNodeVersion) -and (Test-Path $bundledNodeExe)) {
    $env:PATH = "$bundledNode;$env:PATH"
    $nodeVersion = Get-CurrentNodeVersion
}

if (-not $nodeVersion -or $nodeVersion -lt $minimumNodeVersion) {
    throw "Node.js 22.13 or newer is required. Install it from https://nodejs.org/ and try again."
}

$vinext = Join-Path $projectRoot "node_modules\.bin\vinext.cmd"
if (-not (Test-Path $vinext)) {
    throw "Project dependencies are missing. Run npm install in this folder first."
}

$env:WRANGLER_LOG_PATH = ".wrangler/wrangler.log"
Write-Host ""
Write-Host "Starting the Zhejiang Civil Service Query System..." -ForegroundColor Green
Write-Host "Open http://localhost:3000/ in your browser." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop the local server." -ForegroundColor DarkGray
Write-Host ""

Set-Location -LiteralPath $projectRoot
& $vinext dev
