<#
  serve.ps1 - a tiny static file server for this folder.

  Why it exists: this machine has no Node and no Python. Browsers also treat
  file:// pages as opaque origins, which blocks things such as the UI test
  harness (uitest.html) that needs same-origin access to index.html.

  Usage:
    powershell -ExecutionPolicy Bypass -File serve.ps1
    powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8123

  Then browse to http://localhost:8080/
#>
param(
  [int]$Port = 8080,
  [string]$Root = ''
)

if (-not $Root) { $Root = $PSScriptRoot }
if (-not $Root) { $Root = (Get-Location).Path }
$Root = (Resolve-Path -LiteralPath $Root).Path

$script:Types = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.webmanifest' = 'application/manifest+json'
  '.ico'  = 'image/x-icon'
  '.png'  = 'image/png'
  '.md'   = 'text/plain; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.ps1'  = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

try {
  $listener.Start()
} catch {
  Write-Error "Could not listen on http://localhost:$Port/ - $($_.Exception.Message)"
  exit 1
}

Write-Host "Mash Todo List is being served from $Root"
Write-Host "  app        http://localhost:$Port/"
Write-Host "  engine     http://localhost:$Port/tests.html"
Write-Host "  ui tests   http://localhost:$Port/uitest.html"
Write-Host "Press Ctrl+C to stop."

while ($listener.IsListening) {
  $context = $null
  try {
    $context = $listener.GetContext()
  } catch {
    break
  }

  try {
    $relative = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath).TrimStart('/')
    if (-not $relative) { $relative = 'index.html' }

    $candidate = Join-Path $Root ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    $full = [IO.Path]::GetFullPath($candidate)

    if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
      $context.Response.StatusCode = 403
      $body = [Text.Encoding]::UTF8.GetBytes('403 Forbidden')
    } elseif (Test-Path -LiteralPath $full -PathType Leaf) {
      $bytes = [IO.File]::ReadAllBytes($full)
      $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
      if ($script:Types.ContainsKey($ext)) { $context.Response.ContentType = $script:Types[$ext] }
      else { $context.Response.ContentType = 'application/octet-stream' }
      $context.Response.Headers.Add('Cache-Control', 'no-store')
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      $body = $null
    } else {
      $context.Response.StatusCode = 404
      $body = [Text.Encoding]::UTF8.GetBytes("404 Not Found: $relative")
    }

    if ($body) { $context.Response.OutputStream.Write($body, 0, $body.Length) }
  } catch {
    Write-Warning "Request failed: $($_.Exception.Message)"
  } finally {
    try { $context.Response.Close() } catch { }
  }
}

$listener.Stop()
