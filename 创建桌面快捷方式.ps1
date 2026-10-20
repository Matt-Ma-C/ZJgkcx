$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot '桌面启动.vbs'
if (-not (Test-Path -LiteralPath $entry)) { throw '缺少桌面启动.vbs，无法创建快捷方式。' }
$desktopDir = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopDir '岗查查.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    $backupDir = Join-Path $PSScriptRoot 'work\shortcut-backup'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Copy-Item -LiteralPath $shortcutPath -Destination (Join-Path $backupDir ('岗查查-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.lnk'))
}
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcut = $shortcutShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '//B //Nologo "' + $entry + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 1
$shortcut.Description = '岗查查本地快捷版：后台启动服务并打开浏览器'
$appIcon = Join-Path $PSScriptRoot 'public\gangchacha.ico'
if (Test-Path -LiteralPath $appIcon) { $shortcut.IconLocation = $appIcon + ',0' }
$shortcut.Save()
Write-Output $shortcutPath
