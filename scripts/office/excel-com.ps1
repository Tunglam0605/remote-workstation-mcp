param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
$excel = $null
$workbook = $null
$oldAutomationSecurity = $null
$automationSecurityChanged = $false
$release = { param($obj) if ($null -ne $obj) { try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($obj) } catch {} } }
try {
  $request = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($request.action -ne 'validate-render') { throw 'Unsupported Excel COM action.' }
  $workbookPath = [System.IO.Path]::GetFullPath([string]$request.workbookPath)
  $outputPdfPath = [System.IO.Path]::GetFullPath([string]$request.outputPdfPath)
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.EnableEvents = $false
  try { $excel.AskToUpdateLinks = $false } catch {}
  try {
    $oldAutomationSecurity = $excel.AutomationSecurity
    $excel.AutomationSecurity = 3 # msoAutomationSecurityForceDisable
    $automationSecurityChanged = $true
  } catch {}
  try {
    $workbook = $excel.Workbooks.Open($workbookPath, 0, $true, 5, '', '', $true)
  } finally {
    if ($automationSecurityChanged) { try { $excel.AutomationSecurity = $oldAutomationSecurity } catch {} ; $automationSecurityChanged = $false }
  }
  if ([bool]$request.recalculate) {
    $excel.CalculateFullRebuild()
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ($excel.CalculationState -ne 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ($excel.CalculationState -ne 0) { throw 'Excel calculation did not reach Done state within 20 seconds.' }
  }
  $formulaErrors = 0
  foreach ($sheet in @($workbook.Worksheets)) {
    $errors = $null
    try {
      # xlCellTypeFormulas=-4123, xlErrors=16
      $errors = $sheet.Cells.SpecialCells(-4123, 16)
      $formulaErrors += [int]$errors.CountLarge
    } catch {} finally { & $release $errors; & $release $sheet }
  }
  if ([bool]$request.exportPdf) {
    $parent = [System.IO.Path]::GetDirectoryName($outputPdfPath)
    if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
    $workbook.ExportAsFixedFormat(0, $outputPdfPath)
  }
  [pscustomobject]@{
    ok = $true
    excelVersion = [string]$excel.Version
    sheets = [int]$workbook.Worksheets.Count
    formulaErrors = $formulaErrors
    calculationState = [int]$excel.CalculationState
    pdfPath = if ([bool]$request.exportPdf) { $outputPdfPath } else { $null }
  } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 2
} finally {
  if ($automationSecurityChanged -and $null -ne $excel) { try { $excel.AutomationSecurity = $oldAutomationSecurity } catch {} }
  if ($null -ne $workbook) { try { $workbook.Close($false) } catch {} }
  & $release $workbook
  if ($null -ne $excel) { try { $excel.Quit() } catch {} }
  & $release $excel
  [GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
