# Installiert Lumacast nach %LOCALAPPDATA%\Programs\Lumacast und legt Verknuepfungen an.
# Erneut ausfuehren, um nach Aenderungen am Quellcode zu aktualisieren.
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $env:LOCALAPPDATA 'Lumacast\dev-runtime'
$target = Join-Path $env:LOCALAPPDATA 'Programs\Lumacast'

Write-Host '== Lumacast installieren ==' -ForegroundColor Cyan

# 1. FFmpeg
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
$wingetFf = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue
if (-not $ff -and -not $wingetFf) {
  Write-Host 'FFmpeg fehlt - installiere ueber winget ...'
  winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements --disable-interactivity
}

# 2. Electron-Laufzeit (ausserhalb von OneDrive)
$electronDist = Join-Path $runtime 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $electronDist 'electron.exe'))) {
  Write-Host 'Lade Electron ...'
  New-Item -ItemType Directory -Force $runtime | Out-Null
  Push-Location $runtime
  if (-not (Test-Path package.json)) { '{"name":"lumacast-runtime","private":true}' | Out-File -Encoding ascii package.json }
  npm install electron@44 rcedit --no-audit --no-fund
  node node_modules\electron\install.js
  Pop-Location
}

# 3. Laufende Instanz beenden und Dateien kopieren
Get-Process Lumacast -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item -Recurse -Force (Join-Path $electronDist '*') $target
Rename-Item (Join-Path $target 'electron.exe') 'Lumacast.exe'
Remove-Item -Force (Join-Path $target 'resources\default_app.asar') -ErrorAction SilentlyContinue
$app = Join-Path $target 'resources\app'
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item -Force (Join-Path $src 'package.json') $app
Copy-Item -Recurse -Force (Join-Path $src 'src') $app
Copy-Item -Recurse -Force (Join-Path $src 'assets') $app

# 4. Icon + Versionsinfo in die EXE schreiben (falls rcedit vorhanden)
$rcedit = Get-ChildItem (Join-Path $runtime 'node_modules\rcedit\bin') -Filter 'rcedit*.exe' -ErrorAction SilentlyContinue | Where-Object Name -match 'x64' | Select-Object -First 1
if ($rcedit) {
  & $rcedit.FullName (Join-Path $target 'Lumacast.exe') --set-icon (Join-Path $app 'assets\icon.ico') `
    --set-version-string ProductName Lumacast --set-version-string FileDescription Lumacast `
    --set-version-string CompanyName Lumacast --set-version-string OriginalFilename Lumacast.exe
}

# 5. Verknuepfungen
$shell = New-Object -ComObject WScript.Shell
$exe = Join-Path $target 'Lumacast.exe'
$icon = Join-Path $app 'assets\icon.ico'
$links = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Lumacast.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Lumacast.lnk')
)
foreach ($l in $links) {
  $s = $shell.CreateShortcut($l)
  $s.TargetPath = $exe
  $s.WorkingDirectory = $target
  $s.IconLocation = "$icon,0"
  $s.Description = 'Lumacast - Multistream-Studio'
  $s.Save()
}
Write-Host "Fertig: $exe" -ForegroundColor Green
Write-Host 'Verknuepfungen auf dem Desktop und im Startmenue angelegt.'
