$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeDir = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin'
if (Test-Path (Join-Path $nodeDir 'node.exe')) { $env:PATH = "$nodeDir;$env:PATH" }
$node = (Get-Command node -ErrorAction Stop).Source
if ([version]((& $node --version).TrimStart('v')) -lt [version]'22.13.0') { throw '需要 Node.js 22.13 或更高版本。' }
# npm.cmd may prefer an older node.exe beside itself; keep the selected runtime.
$npmCli = Get-Command npm.cmd -All -ErrorAction Stop | ForEach-Object {
    Join-Path (Split-Path -Parent $_.Source) 'node_modules\npm\bin\npm-cli.js'
} | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $npmCli) { throw '未找到 npm-cli.js，请安装 npm 10 或更高版本。' }
& $node $npmCli run build
if ($LASTEXITCODE -ne 0) { throw '构建失败，现有本地版本保持不变。' }
& $node (Join-Path $PSScriptRoot 'scripts/local-runtime.mjs') prepare
if ($LASTEXITCODE -ne 0) { throw '本地版本准备或数据库校验失败，现有版本指针保持不变。' }
Write-Host '本地版本及持久数据库已就绪。正在运行的版本保持服务，停止旧本地服务并重新打开快捷方式后生效。'
