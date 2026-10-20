param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$url = 'http://127.0.0.1:43128/'
$log = Join-Path $PSScriptRoot '桌面启动.log'
$watch = [Diagnostics.Stopwatch]::StartNew()
$mutex = New-Object Threading.Mutex($false, 'Local\GangchachaProductionLauncher')
$locked = $false
function Get-Ready {
    try {
        $request = [Net.HttpWebRequest]::Create($url + '__gangchacha_health')
        $request.Proxy = $null
        $request.Timeout = 500
        $request.ReadWriteTimeout = 500
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { $state = $reader.ReadToEnd() | ConvertFrom-Json; return ($state.app -eq 'gangchacha' -and $state.version -eq 1) }
        finally { $reader.Dispose(); $response.Dispose() }
    } catch { return $false }
}
try {
    try { $locked = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw '另一个启动任务未完成，请查看桌面启动.log。' }
    if (-not (Get-Ready)) {
        $node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
        if ([version]((& $node --version).TrimStart('v')) -lt [version]'22.13.0') { throw '需要 Node.js 22.13 或更高版本。' }
        if (-not (Test-Path (Join-Path $PSScriptRoot '.local-runtime/current.json'))) { throw '缺少本地运行版本，请运行“更新本地版本.ps1”。' }
        $inputFile = Join-Path $PSScriptRoot '.local-runtime/stdin.txt'
        [IO.File]::WriteAllText($inputFile, '')
        $entry = Join-Path $PSScriptRoot 'scripts/local-server.mjs'
        $process = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardInput $inputFile -RedirectStandardOutput (Join-Path $PSScriptRoot '启动服务.log') -RedirectStandardError (Join-Path $PSScriptRoot '启动服务错误.log')
        $deadline = (Get-Date).AddSeconds(15)
        do {
            $ready = Get-Ready
            if ($ready) { break }
            if ($process.HasExited) { throw '本地服务启动失败（可能端口被占用）。请查看启动服务错误.log。' }
            Start-Sleep -Milliseconds 150
        } while ((Get-Date) -lt $deadline)
        if (-not $ready) { throw '本地服务未在15秒内就绪，请查看启动服务错误.log。' }
    }
    if (-not $NoBrowser) { Start-Process $url }
    Add-Content $log "$(Get-Date -Format s) Production ready in $($watch.ElapsedMilliseconds)ms; browser=$(-not $NoBrowser)" -Encoding UTF8
    if ($NoBrowser) { Write-Output $watch.ElapsedMilliseconds }
} catch {
    Add-Content $log "$(Get-Date -Format s) ERROR: $($_.Exception.Message)" -Encoding UTF8
    if ($NoBrowser) { throw }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, '岗查查启动失败') | Out-Null
} finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }