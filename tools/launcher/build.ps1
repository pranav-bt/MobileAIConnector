# Rebuilds "Agent HQ.exe" on the Desktop from AgentHqLauncher.cs.
#   powershell -ExecutionPolicy Bypass -File tools\launcher\build.ps1
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$src = Join-Path $PSScriptRoot "AgentHqLauncher.cs"
$ico = Join-Path $root "packages\desktop\src-tauri\icons\icon.ico"
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) "Agent HQ.exe"
& $csc /nologo /target:winexe /optimize+ /out:"$out" /win32icon:"$ico" `
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "$src"
if ($LASTEXITCODE -eq 0) { "built: $out" } else { "FAILED ($LASTEXITCODE)"; exit 1 }
