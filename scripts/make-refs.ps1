# Builds the committed 1600px reference JPEGs from the full-size generated PNGs.
#
# The deploy needs these: .railwayignore keeps the multi-megabyte PNGs out of the upload, so at runtime
# uploadAsset() looks for media/refs/<repo__path>.jpg and only falls back to downscaling a PNG that is not
# there in production. A location without its ref has no reference image in the deployed game.
#
# Normally ffmpeg does this, but it is not on PATH on this machine, so use .NET imaging instead.
#
#   powershell -File scripts/make-refs.ps1 chapel boiler-room motor-pool records-room morgue

param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Ids)

Add-Type -AssemblyName System.Drawing

$TargetWidth = 1600
$Quality = 90

foreach ($id in $Ids) {
    $src = Join-Path $PSScriptRoot "..\common-generated-assets\environments\$id.png"
    $out = Join-Path $PSScriptRoot "..\media\refs\common-generated-assets__environments__$id.jpg"

    if (-not (Test-Path $src)) { Write-Output "MISSING $src"; continue }

    $img = [System.Drawing.Image]::FromFile((Resolve-Path $src))
    try {
        # Keep the aspect ratio and round to an even height, matching the ffmpeg "scale=1600:-2" the others used.
        $h = [int][Math]::Round($img.Height * ($TargetWidth / $img.Width))
        if ($h % 2 -ne 0) { $h++ }

        $bmp = New-Object System.Drawing.Bitmap $TargetWidth, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.DrawImage($img, 0, 0, $TargetWidth, $h)

        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $params = New-Object System.Drawing.Imaging.EncoderParameters 1
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [int]$Quality)

        $full = [IO.Path]::GetFullPath($out)
        $bmp.Save($full, $codec, $params)
        $kb = [int]((Get-Item $full).Length / 1KB)
        Write-Output "$id -> ${TargetWidth}x${h}, ${kb} KB"
    }
    finally {
        if ($g) { $g.Dispose() }
        if ($bmp) { $bmp.Dispose() }
        $img.Dispose()
    }
}
