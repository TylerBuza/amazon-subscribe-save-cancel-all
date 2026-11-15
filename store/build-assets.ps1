$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot

function New-Canvas([int]$width, [int]$height) {
  $bitmap = New-Object Drawing.Bitmap($width, $height, ([Drawing.Imaging.PixelFormat]::Format24bppRgb))
  $g = [Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $rect = New-Object Drawing.Rectangle(0, 0, $width, $height)
  $brush = New-Object Drawing.Drawing2D.LinearGradientBrush($rect, [Drawing.Color]::FromArgb(14,18,25), [Drawing.Color]::FromArgb(28,35,47), 65.0)
  $g.FillRectangle($brush, $rect)
  $brush.Dispose()
  return @{ Bitmap = $bitmap; Graphics = $g }
}

function Draw-Text($g, [string]$text, [float]$x, [float]$y, [float]$size, [string]$color, [bool]$bold = $false) {
  $style = if ($bold) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }
  $font = New-Object Drawing.Font('Segoe UI', $size, $style, ([Drawing.GraphicsUnit]::Pixel))
  $brush = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml($color))
  $g.DrawString($text, $font, $brush, $x, $y)
  $font.Dispose()
  $brush.Dispose()
}

function Save-Canvas($canvas, [string]$name) {
  $canvas.Bitmap.Save((Join-Path $PSScriptRoot $name), [Drawing.Imaging.ImageFormat]::Png)
  $canvas.Graphics.Dispose()
  $canvas.Bitmap.Dispose()
}

$overview = [Drawing.Image]::FromFile((Join-Path $root 'screenshots\overview.png'))
$panel = [Drawing.Image]::FromFile((Join-Path $root 'screenshots\panel.png'))
$popup = [Drawing.Image]::FromFile((Join-Path $root 'screenshots\popup.png'))
$icon = [Drawing.Image]::FromFile((Join-Path $root 'icons\icon128.png'))
try {
  $canvas = New-Canvas 1280 800
  Draw-Text $canvas.Graphics 'Keep what you want.' 42 36 46 '#ffb44c' $true
  Draw-Text $canvas.Graphics 'Cancel the subscriptions you no longer need.' 42 100 29 '#eef0f3'
  $canvas.Graphics.DrawImage($overview, 32, 198, 1216, 558)
  Save-Canvas $canvas 'screenshot-01.png'

  $canvas = New-Canvas 1280 800
  Draw-Text $canvas.Graphics 'Your subscriptions, under control.' 42 30 42 '#eef0f3' $true
  Draw-Text $canvas.Graphics 'Floating Amazon panel' 46 142 30 '#ffb44c' $true
  Draw-Text $canvas.Graphics 'Keep favorites and cancel the rest.' 46 184 21 '#b6beca'
  $dest = New-Object Drawing.Rectangle(46, 245, 515, 486)
  $crop = New-Object Drawing.Rectangle(35, 270, 515, 486)
  $canvas.Graphics.DrawImage($panel, $dest, $crop, [Drawing.GraphicsUnit]::Pixel)
  Draw-Text $canvas.Graphics 'Browser extension menu' 770 100 27 '#ffb44c' $true
  $dest = New-Object Drawing.Rectangle(790, 150, 370, 614)
  $crop = New-Object Drawing.Rectangle(46, 105, 493, 818)
  $canvas.Graphics.DrawImage($popup, $dest, $crop, [Drawing.GraphicsUnit]::Pixel)
  Save-Canvas $canvas 'screenshot-02.png'

  $canvas = New-Canvas 440 280
  $canvas.Graphics.DrawImage($icon, 140, 38, 160, 160)
  Draw-Text $canvas.Graphics 'Subscribe & Save' 100 215 27 '#eef0f3' $true
  Save-Canvas $canvas 'promo-small.png'

  $storeIcon = New-Object Drawing.Bitmap(128, 128)
  $g = [Drawing.Graphics]::FromImage($storeIcon)
  $g.Clear([Drawing.Color]::Transparent)
  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($icon, 16, 16, 96, 96)
  $storeIcon.Save((Join-Path $PSScriptRoot 'icon128.png'), [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $storeIcon.Dispose()
} finally {
  $overview.Dispose()
  $panel.Dispose()
  $popup.Dispose()
  $icon.Dispose()
}
Write-Output 'Created two 1280x800 screenshots, a 440x280 promo image, and a 128x128 store icon.'
