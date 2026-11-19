$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$publicDir = Join-Path $root 'public'
if (-not (Test-Path $publicDir)) {
  New-Item -ItemType Directory -Path $publicDir | Out-Null
}

$pngPath = Join-Path $publicDir 'installr.png'
$icoPath = Join-Path $publicDir 'installr.ico'

$size = 256
$bitmap = New-Object System.Drawing.Bitmap $size, $size
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
$backgroundBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 22, 72, 184)), ([System.Drawing.Color]::FromArgb(255, 6, 24, 70)), 45
$graphics.FillRectangle($backgroundBrush, $rect)

$highlightBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(65, 110, 176, 255))
$graphics.FillEllipse($highlightBrush, 20, 20, 216, 140)

$ringPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(210, 164, 212, 255), 12)
$graphics.DrawEllipse($ringPen, 28, 28, 200, 200)

$textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 238, 246, 255))
$font = [System.Drawing.Font]::new('Segoe UI', 108, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$stringFormat = New-Object System.Drawing.StringFormat
$stringFormat.Alignment = [System.Drawing.StringAlignment]::Center
$stringFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = [System.Drawing.RectangleF]::new(0, 0, $size, $size)
$graphics.DrawString('I', $font, $textBrush, $textRect, $stringFormat)

$bitmap.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$pngStream = New-Object System.IO.MemoryStream
$bitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $pngStream.ToArray()
$pngStream.Dispose()

$fileStream = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter $fileStream

$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]1)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]32)
$writer.Write([UInt32]$pngBytes.Length)
$writer.Write([UInt32]22)
$writer.Write($pngBytes)

$writer.Dispose()
$fileStream.Dispose()

$font.Dispose()
$textBrush.Dispose()
$ringPen.Dispose()
$highlightBrush.Dispose()
$backgroundBrush.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Host "Created icon files: $icoPath and $pngPath"
