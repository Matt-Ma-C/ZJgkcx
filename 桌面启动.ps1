$ErrorActionPreference = 'Stop'
$url = 'http://localhost:3000/'
$log = Join-Path $PSScriptRoot '桌面启动.log'
$mutex = New-Object Threading.Mutex($false, 'Local\ZhejiangCivilServiceLauncher')
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); exit }
function Test-SystemReady {
    try {
        $request = [Net.HttpWebRequest]::Create($url)
        $request.Proxy = $null
        $request.Timeout = 5000
        $request.ReadWriteTimeout = 5000
        $response = $request.GetResponse()
        $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
        try { $html = $reader.ReadToEnd(); return $html.Contains('岗查查') -or $html.Contains('浙江公务员考情查询') }
        finally { $reader.Dispose(); $response.Dispose() }
    } catch { return $false }
}
try {
    Add-Content $log "$(Get-Date -Format s) Checking local service" -Encoding UTF8
    if (-not (Test-SystemReady)) {
        $listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
        if (-not $listener) {
            $startScript = Join-Path $PSScriptRoot '启动系统.ps1'
            $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $startScript + '"'
            Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot '启动服务.log') -RedirectStandardError (Join-Path $PSScriptRoot '启动服务错误.log')
        }
        $deadline = (Get-Date).AddSeconds(180)
        do {
            Start-Sleep -Seconds 2
            $ready = Test-SystemReady
            Add-Content $log "$(Get-Date -Format s) Waiting for service; ready=$ready" -Encoding UTF8
        } until ($ready -or (Get-Date) -gt $deadline)
        if (-not $ready) { throw '系统启动失败或3000端口被占用。请查看项目中的启动服务.log、启动服务错误.log。' }
    }
    Start-Process $url
    Add-Content $log "$(Get-Date -Format s) Browser opened: $url" -Encoding UTF8
} catch {
    Add-Content $log "$(Get-Date -Format s) ERROR: $($_.Exception.Message)" -Encoding UTF8
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, '岗查查') | Out-Null
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }