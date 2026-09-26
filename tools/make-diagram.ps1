Add-Type -AssemblyName System.Drawing

# Generates docs/images/period-modes.png: how the three reporting periods differ.
# Written as a .ps1 file (not inline) so the Chinese labels are read from disk as
# UTF-8 rather than passing through a shell argument, which corrupts them.

$W = 1600
$H = 900

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

# Palette, matching the app's light theme.
$bg = [System.Drawing.Color]::FromArgb(255, 247, 247, 245)
$card = [System.Drawing.Color]::White
$ink = [System.Drawing.Color]::FromArgb(255, 26, 26, 26)
$muted = [System.Drawing.Color]::FromArgb(255, 122, 122, 122)
$line = [System.Drawing.Color]::FromArgb(255, 226, 226, 222)
$income = [System.Drawing.Color]::FromArgb(255, 22, 163, 74)
$expense = [System.Drawing.Color]::FromArgb(255, 220, 38, 38)
$accent = [System.Drawing.Color]::FromArgb(255, 86, 157, 250)
$accentSoft = [System.Drawing.Color]::FromArgb(255, 219, 234, 254)
$warn = [System.Drawing.Color]::FromArgb(255, 180, 83, 9)
$warnSoft = [System.Drawing.Color]::FromArgb(255, 254, 243, 199)
$neutralSoft = [System.Drawing.Color]::FromArgb(255, 240, 240, 238)

$g.Clear($bg)

function Font([single]$size, [string]$style = 'Regular') {
  New-Object System.Drawing.Font('Microsoft YaHei UI', $size, [System.Drawing.FontStyle]::$style, [System.Drawing.GraphicsUnit]::Pixel)
}

function Text([string]$s, [single]$x, [single]$y, [System.Drawing.Font]$font, $color) {
  $brush = New-Object System.Drawing.SolidBrush($color)
  $g.DrawString($s, $font, $brush, $x, $y)
  $brush.Dispose()
}

function RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r, $fill, $stroke) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  if ($fill) {
    $b = New-Object System.Drawing.SolidBrush($fill)
    $g.FillPath($b, $path)
    $b.Dispose()
  }
  if ($stroke) {
    $p = New-Object System.Drawing.Pen($stroke, 1)
    $g.DrawPath($p, $path)
    $p.Dispose()
  }
  $path.Dispose()
}

$titleFont = Font 34 'Bold'
$subFont = Font 17
$cardTitle = Font 21 'Bold'
$bodyFont = Font 16
$monoFont = New-Object System.Drawing.Font('Consolas', 16, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$tagFont = Font 14 'Bold'

# ---------------------------------------------------------------- header
Text '三种统计周期，一个首页' 60 46 $titleFont $ink
Text '同一份账本，同一块首页。切换周期只改变「统计哪一段时间」，不修改任何一笔已记录的金额。' 60 96 $subFont $muted

# ---------------------------------------------------------------- timeline
$tlX = 60
$tlY = 150
$tlW = 1480
$tlH = 122

RoundRect $tlX $tlY $tlW $tlH 14 $card $line

Text '生活费 5 号到账，所以「这个月」是 8月5日 → 9月4日' ($tlX + 24) ($tlY + 18) $bodyFont $ink

$barY = $tlY + 62
$barH = 30
$segW = $tlW / 3

# Three consecutive cycles, drawn as tiles so the tiling property is visible.
$segments = @(
  @{ label = '8月5日 – 9月4日'; from = 0 },
  @{ label = '9月5日 – 10月4日'; from = 1 },
  @{ label = '10月5日 – 11月4日'; from = 2 }
)
foreach ($seg in $segments) {
  $x = $tlX + 24 + ($seg.from * ($segW - 16))
  # NOT $w: PowerShell variable names are case-insensitive, so assigning to $w
  # silently overwrote the canvas width $W, and every later size was then computed
  # from a 477-pixel "canvas" — which is exactly why the mode cards came out 103px
  # wide instead of 477px.
  $segBoxW = $segW - 16
  RoundRect $x $barY $segBoxW $barH 8 $accentSoft $accent
  $labelFont = Font 15
  $size = $g.MeasureString($seg.label, $labelFont)
  Text $seg.label ($x + (($segBoxW - $size.Width) / 2)) ($barY + 6) $labelFont $accent
  $labelFont.Dispose()
}

# Today's marker on the first cycle, to show which slice "now" falls in.
$markX = $tlX + 24 + ($segW * 0.55)
$markPen = New-Object System.Drawing.Pen($expense, 2)
$g.DrawLine($markPen, $markX, $barY - 10, $markX, $barY + $barH + 10)
$markPen.Dispose()
Text '今天' ($markX - 18) ($barY + $barH + 12) $tagFont $expense

Text '周期首尾相接，不重叠也不留空 —— 否则一笔交易会同时落进两个周期，或者掉进缝里。' ($tlX + 24) ($tlY + $tlH - 30) $bodyFont $muted

# ---------------------------------------------------------------- three modes
# Sizes are measured, not guessed: '2026年9月 · 5 日起算' at 16px is about 200px and
# the longest body line about 300px, so a 482px card holds both with room to spare.
$cardY = 320
$cardH = 274
$gap = 24
$cardW = ($W - 120 - ($gap * 2)) / 3

$modes = @(
  @{
    title = '1  自然月'
    tag = '1 日 → 月末'
    body = '不管生活费几号到账，'
    body2 = '就是日历上的那个月。'
    use = '对账、报销、和家里人核对账单时用。'
    fill = $neutralSoft
    accent = $muted
    window = '2026年9月'
    range = '09-01 → 09-30'
  },
  @{
    title = '2  结算周期'
    tag = '起始日 1–28'
    body = '按你的到账日切分，'
    body2 = '这是首页的默认视图。'
    use = '「还剩几天、还能花多少」用这个。'
    fill = $accentSoft
    accent = $accent
    window = '2026年9月 · 5 日起算'
    range = '09-05 → 10-04 · 30 天'
  },
  @{
    title = '3  自定义区间'
    tag = '任意起止日期'
    body = '一个学期、一趟旅行、'
    body2 = '两次兼职之间的那段日子。'
    use = '输入区间总金额，看会不会超支。'
    fill = $warnSoft
    accent = $warn
    window = '2026 秋季学期'
    range = '09-01 → 12-31 · 122 天'
  }
)

for ($i = 0; $i -lt 3; $i++) {
  $mode = $modes[$i]
  $x = 60 + ($i * ($cardW + $gap))

  RoundRect $x $cardY $cardW $cardH 16 $card $line

  Text $mode.title ($x + 24) ($cardY + 22) $cardTitle $ink

  # The tag sits on its own row beneath the title: on one line, '3  自定义区间'
  # ran straight into the tag box.
  $tagWidth = 118
  RoundRect ($x + 24) ($cardY + 58) $tagWidth 26 13 $mode.fill $null
  $ts = $g.MeasureString($mode.tag, $tagFont)
  Text $mode.tag ($x + 24 + (($tagWidth - $ts.Width) / 2)) ($cardY + 63) $tagFont $mode.accent

  Text $mode.body ($x + 24) ($cardY + 100) $bodyFont $muted
  Text $mode.body2 ($x + 24) ($cardY + 124) $bodyFont $muted

  # Example window box.
  $boxY = $cardY + 158
  RoundRect ($x + 24) $boxY ($cardW - 48) 72 10 $mode.fill $null
  Text $mode.window ($x + 40) ($boxY + 12) $monoFont $ink
  Text $mode.range ($x + 40) ($boxY + 40) $monoFont $mode.accent

  Text $mode.use ($x + 24) ($cardY + 244) $bodyFont $muted
}

# ---------------------------------------------------------------- footer
$footY = 620
RoundRect 60 $footY 1480 118 14 $card $line
Text '切换周期不会改动你的设置，也不会改动账本' 84 ($footY + 20) $cardTitle $ink
Text '在首页点「自然月」看日历月，你的结算起始日仍然保存在设置里；点「结算周期」立刻回到 5 日起算。' 84 ($footY + 58) $bodyFont $muted
Text '自定义区间会被记住，下次打开 App 还是那一段。' 84 ($footY + 84) $bodyFont $muted

$noteY = 770
Text '所有金额都以整数最小单位存储，跨币种先分币种求和、再统一换算，全程只舍入一次 —— 所以换周期不会让数字对不上。' 60 $noteY $bodyFont $muted

$out = Join-Path $PSScriptRoot '..\docs\images\period-modes.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Output ("canvas ${W}x${H}  cardW=$([math]::Round($cardW,1))  cardH=$cardH  gap=$gap")
Write-Output ("wrote " + (Resolve-Path $out).Path)
