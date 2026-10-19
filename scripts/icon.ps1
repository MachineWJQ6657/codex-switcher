$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$resourceDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'resources'
[System.IO.Directory]::CreateDirectory($resourceDir) | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
$shape.AddArc(8, 8, 60, 60, 180, 90)
$shape.AddArc(188, 8, 60, 60, 270, 90)
$shape.AddArc(188, 188, 60, 60, 0, 90)
$shape.AddArc(8, 188, 60, 60, 90, 90)
$shape.CloseFigure()
$brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(23, 63, 55))
$graphics.FillPath($brush, $shape)
$pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 7)
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$diamond = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(65, 103), [System.Drawing.PointF]::new(128, 70), [System.Drawing.PointF]::new(191, 103), [System.Drawing.PointF]::new(128, 136))
$graphics.DrawPolygon($pen, $diamond)
foreach ($level in @(126, 149)) {
  $points = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(65, $level), [System.Drawing.PointF]::new(128, ($level + 33)), [System.Drawing.PointF]::new(191, $level))
  $graphics.DrawLines($pen, $points)
}
$png = [System.IO.MemoryStream]::new()
$bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bytes = $png.ToArray()
[System.IO.File]::WriteAllBytes((Join-Path $resourceDir 'icon.png'), $bytes)
$stream = [System.IO.File]::Create((Join-Path $resourceDir 'icon.ico'))
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
$writer.Write([Byte]0); $writer.Write([Byte]0); $writer.Write([Byte]0); $writer.Write([Byte]0)
$writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$bytes.Length); $writer.Write([UInt32]22)
$writer.Write($bytes)
$writer.Dispose(); $stream.Dispose(); $png.Dispose(); $pen.Dispose(); $brush.Dispose(); $shape.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
