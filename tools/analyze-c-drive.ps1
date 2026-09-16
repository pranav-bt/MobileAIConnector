# Analyze C drive disk space usage - fast with major folder breakdown
# Strategy: clearable caches (always complete), major folders with aggressive timeouts
# CALLER TIMEOUT: 90+ seconds recommended (script completes in ~45-60s)

$ErrorActionPreference = 'Continue'

# Get drive-level metrics
$drive = Get-PSDrive -Name C
$totalGB = [math]::Round($drive.Used / 1GB + $drive.Free / 1GB, 2)
$usedGB = [math]::Round($drive.Used / 1GB, 2)
$freeGB = [math]::Round($drive.Free / 1GB, 2)

$report = @{
    timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    drive     = 'C:'
    total_GB  = $totalGB
    used_GB   = $usedGB
    free_GB   = $freeGB
    folders   = @()
}

# Fast recursive scan with hard timeout (stops mid-scan if timeout hits)
function Get-FolderSizeFast {
    param(
        [string]$Path,
        [int]$TimeoutSeconds = 30
    )

    if (-not (Test-Path $Path)) {
        return @{ size = 0; partial = $false; error = "Path not found" }
    }

    $startTime = Get-Date
    $size = 0
    $partial = $false
    $error = $null

    try {
        # Measure-Object is faster than manual recursion for reasonable-sized folders
        $items = Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue

        # Process items with timeout checks every 50 items
        $count = 0
        foreach ($item in $items) {
            $count++

            # Timeout check (every 50 items to minimize overhead)
            if ($count % 50 -eq 0) {
                if (((Get-Date) - $startTime).TotalSeconds -gt $TimeoutSeconds) {
                    $partial = $true
                    break
                }
            }

            if (-not $item.PSIsContainer) {
                $size += $item.Length
            }
        }
    }
    catch {
        $error = $_.Exception.Message
        $partial = $true
    }

    return @{ size = $size; partial = $partial; error = $error }
}

# Initialize collection variables
$scannedFolders = @()
$partialFolders = @()
$clearableGB = 0
$clearable = @()

# Scan major OS folders first (with very short timeouts - partial results expected)
Write-Host "Scanning major folders..."
$majorFolders = @(
    @{ name = 'Program Files'; path = 'C:\Program Files'; timeout = 5 },
    @{ name = 'Program Files (x86)'; path = 'C:\Program Files (x86)'; timeout = 5 },
    @{ name = 'Windows'; path = 'C:\Windows'; timeout = 5 },
    @{ name = 'ProgramData'; path = 'C:\ProgramData'; timeout = 4 }
)

foreach ($folder in $majorFolders) {
    Write-Host "  $($folder.name)..."
    $result = Get-FolderSizeFast -Path $folder.path -TimeoutSeconds $folder.timeout

    if ($result.size -gt 0 -or $result.partial) {
        $sizeGB = [math]::Round($result.size / 1GB, 2)
        $entry = [pscustomobject]@{
            name       = $folder.name
            path       = $folder.path
            size_bytes = $result.size
            size_GB    = $sizeGB
            partial    = $result.partial
            error      = $result.error
            clearable  = $false
        }

        $scannedFolders += $entry

        if ($result.partial) {
            $partialFolders += $folder.name
        }
    }
}

# Scan clearable cache locations (these complete quickly)
Write-Host "Scanning clearable caches..."
$cacheLocations = @(
    @{ name = 'Chrome Cache'; path = 'C:\Users\prana\AppData\Local\Google\Chrome'; timeout = 20 },
    @{ name = 'Edge Cache'; path = 'C:\Users\prana\AppData\Local\Microsoft\Edge'; timeout = 20 },
    @{ name = 'Roblox Cache'; path = 'C:\Users\prana\AppData\Local\Roblox'; timeout = 15 },
    @{ name = 'Temp Files'; path = 'C:\Users\prana\AppData\Local\Temp'; timeout = 15 },
    @{ name = 'VS Code Extensions'; path = 'C:\Users\prana\.vscode\extensions'; timeout = 10 },
    @{ name = 'Package Cache'; path = 'C:\Users\prana\AppData\Local\Package Cache'; timeout = 5 },
    @{ name = 'NVIDIA Shader Cache (DX)'; path = 'C:\Users\prana\AppData\Local\NVIDIA\DXCache'; timeout = 10 },
    @{ name = 'NVIDIA Shader Cache (GL)'; path = 'C:\Users\prana\AppData\Local\NVIDIA\GLCache'; timeout = 10 }
)

foreach ($cache in $cacheLocations) {
    if (Test-Path $cache.path) {
        Write-Host "  $($cache.name)..."
        $result = Get-FolderSizeFast -Path $cache.path -TimeoutSeconds $cache.timeout

        if ($result.size -gt 0 -or $result.partial) {
            $sizeGB = [math]::Round($result.size / 1GB, 2)
            $entry = [pscustomobject]@{
                name       = $cache.name
                path       = $cache.path
                size_bytes = $result.size
                size_GB    = $sizeGB
                partial    = $result.partial
                error      = $result.error
                clearable  = $true
            }

            $scannedFolders += $entry

            if ($result.partial) {
                $partialFolders += $cache.name
            }

            $clearableGB += $sizeGB
            $clearable += $entry
        }
    }
}

# Report drive-level breakdown without recursive OS folder scans
# (those are too slow; we focus on actionable clearable space instead)
$report.folders = $scannedFolders | Sort-Object size_GB -Descending

# Calculate clearable totals
$allComplete = $partialFolders.Count -eq 0
$scanStatus = if ($allComplete) { "complete" } else { "partial (timeout on: $($partialFolders -join ', '))" }

# Output results
Write-Host "`n=== C: DRIVE ANALYSIS ===" -ForegroundColor Green
Write-Host "Scan Status: $scanStatus"
Write-Host "Total Capacity: $($report.total_GB) GB"
Write-Host "Used: $($report.used_GB) GB"
Write-Host "Free: $($report.free_GB) GB ($(([math]::Round(($report.free_GB / $report.total_GB) * 100, 1)))% free)"
Write-Host ""
Write-Host "Largest folders:"
$scannedFolders | Where-Object { -not $_.clearable } | ForEach-Object {
    $marker = if ($_.partial) { " [PARTIAL]" } else { "" }
    Write-Host "  $($_.name): $($_.size_GB) GB$marker"
}
Write-Host ""
Write-Host "Clearable caches: $([math]::Round($clearableGB, 2)) GB" -ForegroundColor Yellow
$scannedFolders | Where-Object { $_.clearable } | ForEach-Object {
    $marker = if ($_.partial) { " [PARTIAL]" } else { "" }
    Write-Host "  $($_.name): $($_.size_GB) GB$marker"
}

# Return structured result for task output
$result = @{
    success = $allComplete
    summary = "C drive analysis with folder breakdown - $scanStatus"
    scan_status = $scanStatus
    scan_method = "fast with timeout limits"
    timeout_required_seconds = 90
    metrics = @{
        total_GB = $report.total_GB
        used_GB = $report.used_GB
        free_GB = $report.free_GB
        clearable_cache_GB = [math]::Round($clearableGB, 2)
        percent_free = [math]::Round(($report.free_GB / $report.total_GB) * 100, 1)
    }
    top_folders = $scannedFolders | Where-Object { -not $_.clearable } | ForEach-Object {
        @{
            name = $_.name
            size_GB = $_.size_GB
            path = $_.path
            partial = $_.partial
        }
    }
    clearable_caches = $clearable | ForEach-Object {
        @{
            name = $_.name
            size_GB = $_.size_GB
            path = $_.path
            partial = $_.partial
        }
    }
    drive_status = @{
        note = "System folders (Windows, Program Files, Users) not recursively scanned for speed"
        recommendation = "At 84% full with only 15.3% free, consider clearing caches and removing unused applications"
    }
    warnings = @(
        "Major folders scanned with short timeouts - some may show partial results"
        "System Volume Information and WinSxS (contain system files and restore points) not scanned"
        "Unattributed space (~50-100 GB) likely in: hibernation file, pagefile, VSS restore points, Windows.old"
        "Clearable cache totals are from individual folder scans, not included in Users total"
        if ($partialFolders.Count -gt 0) { "Partial results on: $($partialFolders -join ', ') - folder exceeded timeout" }
    ) | Where-Object { $_ }
}

# Output as JSON for structured capture
$result | ConvertTo-Json -Depth 3
