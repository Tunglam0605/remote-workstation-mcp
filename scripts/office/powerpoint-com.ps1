param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
$powerPoint = $null
$presentation = $null
$release = { param($obj) if ($null -ne $obj) { try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($obj) } catch {} } }
try {
  $request = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($request.action -ne 'validate-render') { throw 'Unsupported PowerPoint COM action.' }
  $presentationPath = [System.IO.Path]::GetFullPath([string]$request.presentationPath)
  $outputPdfPath = [System.IO.Path]::GetFullPath([string]$request.outputPdfPath)
  $powerPoint = New-Object -ComObject PowerPoint.Application
  try { $powerPoint.DisplayAlerts = 1 } catch {} # ppAlertsNone
  try { $powerPoint.AutomationSecurity = 3 } catch {} # msoAutomationSecurityForceDisable
  # Presentations.Open(FileName, ReadOnly=-1, Untitled=0, WithWindow=0)
  $presentation = $powerPoint.Presentations.Open($presentationPath, -1, 0, 0)
  $slideCount = [int]$presentation.Slides.Count
  $shapeCount = 0
  foreach ($slide in @($presentation.Slides)) {
    try { $shapeCount += [int]$slide.Shapes.Count } finally { & $release $slide }
  }
  if ([bool]$request.exportPdf) {
    $parent = [System.IO.Path]::GetDirectoryName($outputPdfPath)
    if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
    # ppSaveAsPDF = 32. Presentation is opened read-only; SaveAs targets a separate PDF path and never overwrites the source PPTX.
    $presentation.SaveAs($outputPdfPath, 32)
  }
  [pscustomobject]@{
    ok = $true
    powerPointVersion = [string]$powerPoint.Version
    slides = $slideCount
    shapes = $shapeCount
    pdfPath = if ([bool]$request.exportPdf) { $outputPdfPath } else { $null }
  } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 2
} finally {
  if ($null -ne $presentation) { try { $presentation.Close() } catch {} }
  & $release $presentation
  if ($null -ne $powerPoint) { try { $powerPoint.Quit() } catch {} }
  & $release $powerPoint
  [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
