# Build and package extension into an XPI for Windows
# Usage: run this in PowerShell from the repo root

Write-Host "Building XPI using web-ext (npx web-ext build)"

# Prefer global web-ext if available, otherwise use npx
if (Get-Command web-ext -ErrorAction SilentlyContinue) {
    web-ext build --source-dir . --artifacts-dir build
} else {
    npx web-ext build --source-dir . --artifacts-dir build
}

# Find produced .zip or .xpi
$zip = Get-ChildItem build -Filter *.zip -File -ErrorAction SilentlyContinue | Select-Object -First 1
if ($zip) {
    $xpiPath = [System.IO.Path]::ChangeExtension($zip.FullName, '.xpi')
    if (-not (Test-Path $xpiPath)) {
        Write-Host "Renaming $($zip.Name) -> $(Split-Path $xpiPath -Leaf)"
        Rename-Item $zip.FullName $xpiPath
    } else {
        Write-Host "XPI already exists: $xpiPath"
    }
} else {
    $xpi = Get-ChildItem build -Filter *.xpi -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($xpi) {
        $xpiPath = $xpi.FullName
    } else {
        Write-Error "No build artifact (.zip or .xpi) found in build/"
        exit 1
    }
}

Write-Host "XPI ready: $xpiPath"

# Inspect XPI for icons and manifest
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($xpiPath)
    $entries = $archive.Entries
    $iconEntries = $entries | Where-Object { $_.FullName -like 'icons/*' }
    if ($iconEntries.Count -gt 0) {
        Write-Host "Icons included in package:" -ForegroundColor Green
        $iconEntries | ForEach-Object { Write-Host "  - $($_.FullName)" }
    } else {
        Write-Warning "No icons found inside XPI (check icons/ files)."
    }
    $manifestEntry = $entries | Where-Object { $_.FullName -eq 'manifest.json' }
    if ($manifestEntry) {
        $s = $manifestEntry.Open()
        $sr = New-Object System.IO.StreamReader($s)
        $content = $sr.ReadToEnd()
        $sr.Close()
        $s.Close()
        try {
            $m = $content | ConvertFrom-Json
            Write-Host "manifest version: $($m.version)"
        } catch {
            Write-Warning "Failed to parse manifest.json inside XPI"
        }
    }
    $archive.Dispose()
} catch {
    Write-Warning "Could not inspect XPI contents: $_"
}

Write-Host "Done. The XPI file is: $xpiPath" -ForegroundColor Cyan
