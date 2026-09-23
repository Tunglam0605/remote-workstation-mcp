param(
  [Parameter(Mandatory=$true)]
  [string]$InputPath
)

$ErrorActionPreference = 'Stop'
$word = $null
$document = $null
$ownedWordPid = $null
$result = $null
$exitCode = 1

try {
  if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
    throw "Input request file does not exist."
  }

  $request = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($request.action -ne 'validate-render') {
    throw "Unsupported Word native helper action."
  }

  $documentPath = [System.IO.Path]::GetFullPath([string]$request.documentPath)
  if (-not (Test-Path -LiteralPath $documentPath -PathType Leaf)) {
    throw "Word document does not exist."
  }

  $exportPdf = [bool]$request.exportPdf
  $pdfPath = $null
  if ($exportPdf) {
    $pdfPath = [System.IO.Path]::GetFullPath([string]$request.outputPdfPath)
    $pdfParent = [System.IO.Path]::GetDirectoryName($pdfPath)
    if (-not (Test-Path -LiteralPath $pdfParent -PathType Container)) {
      throw "PDF parent directory does not exist."
    }
    if (Test-Path -LiteralPath $pdfPath) {
      Remove-Item -LiteralPath $pdfPath -Force
    }
  }

  $beforePids = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $word = New-Object -ComObject Word.Application
  Start-Sleep -Milliseconds 250
  $afterPids = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $newPids = @($afterPids | Where-Object { $beforePids -notcontains $_ })

  if ($newPids.Count -eq 1) {
    $ownedWordPid = [int]$newPids[0]
  } elseif ($newPids.Count -gt 1) {
    throw "Word automation created multiple unexpected WINWORD processes."
  } elseif ($beforePids.Count -gt 0) {
    throw "WORD_COM_ISOLATION_FAILED: Word automation did not create a distinct process while user Word processes were already running."
  }

  $word.Visible = $false
  $word.DisplayAlerts = 0
  try { $word.AutomationSecurity = 3 } catch {}
  try { $word.Options.UpdateLinksAtOpen = $false } catch {}
  try { $word.Options.SaveNormalPrompt = $false } catch {}

  $document = $word.Documents.Open($documentPath, $false, $true)
  $equations = [int]$document.OMaths.Count
  $pages = [int]$document.ComputeStatistics(2)

  if ($exportPdf) {
    $document.ExportAsFixedFormat($pdfPath, 17)
    if (-not (Test-Path -LiteralPath $pdfPath -PathType Leaf)) {
      throw "Word PDF export did not create an output file."
    }
    $pdfInfo = Get-Item -LiteralPath $pdfPath
    if ($pdfInfo.Length -le 0) {
      throw "Word PDF export produced an empty file."
    }
  }

  $result = @{
    ok = $true
    wordVersion = [string]$word.Version
    pages = $pages
    equations = $equations
    wordPid = $ownedWordPid
  }
  if ($exportPdf) { $result.pdfPath = $pdfPath }
  $exitCode = 0
}
catch {
  $result = @{
    ok = $false
    error = [string]$_.Exception.Message
    wordPid = $ownedWordPid
  }
  $exitCode = 1
}
finally {
  if ($document -ne $null) {
    try { $document.Close(0) } catch {}
  }
  if ($word -ne $null) {
    try { $word.Quit(0) } catch {}
  }
  if ($document -ne $null) {
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) } catch {}
  }
  if ($word -ne $null) {
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) } catch {}
  }
  $document = $null
  $word = $null
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()

  if ($ownedWordPid -ne $null) {
    for ($i = 0; $i -lt 20; $i++) {
      if (-not (Get-Process -Id $ownedWordPid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 100
    }
    $remaining = Get-Process -Id $ownedWordPid -ErrorAction SilentlyContinue
    if ($remaining -ne $null) {
      try { Stop-Process -Id $ownedWordPid -Force -ErrorAction Stop }
      catch {
        $result.ok = $false
        $result.error = "WORD_COM_CLEANUP_FAILED: $($_.Exception.Message)"
        $exitCode = 1
      }
    }
  }
}

[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 8))
exit $exitCode
