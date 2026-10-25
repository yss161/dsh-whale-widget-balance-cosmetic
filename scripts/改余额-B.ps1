# 小鲸鱼挂件：余额显示美化（递减模式）—— 纯美观，给没有余额接口的第三方 API 用
#
# 用法（普通 PowerShell 窗口）：
#   powershell -ExecutionPolicy Bypass -File "改余额B.ps1" 2000
#   powershell -ExecutionPolicy Bypass -File "改余额B.ps1" 2000 -Fixed
#   powershell -ExecutionPolicy Bypass -File "改余额B.ps1" -Restore

param(
  [Parameter(Position = 0)][string]$Amount,
  [switch]$Fixed,
  [switch]$Restore
)

$ErrorActionPreference = "Stop"
$target = "C:\Users\LDX\.dsh\profiles\desktop\node_modules\dsh-whale-widget\assets\whale-widget.js"
$orig   = "$target.orig"

if (-not (Test-Path $target)) { Write-Host "找不到 $target" -ForegroundColor Red; exit 2 }

if ($Restore) {
  if (-not (Test-Path $orig)) { Write-Host "没有原始备份 $orig，无法还原" -ForegroundColor Red; exit 3 }
  Copy-Item $orig $target -Force
  Write-Host "已还原成真实余额。请按 Ctrl+F5 硬刷新页面。" -ForegroundColor Green
  exit 0
}

if (-not $Amount) {
  $Amount = Read-Host "起始余额（例如 2000）"
}
$n = 0.0
if (-not [double]::TryParse($Amount, [ref]$n)) { Write-Host "不是数字: $Amount" -ForegroundColor Red; exit 1 }
$fixedLit = if ($Fixed) { "true" } else { "false" }

# 首次执行时保存原始文件，之后每次都从它重写（幂等，不叠加）
if (-not (Test-Path $orig)) { Copy-Item $target $orig -Force; Write-Host "已备份原始文件 -> $orig" }

$src = Get-Content $orig -Raw
$headAnchor  = "var BALANCE_URL = " + [char]39 + "/dsh-whale/balance.json" + [char]39
$applyAnchor = "var nb = Number(data.totalBalance)"
if ($src -notlike "*$headAnchor*")  { Write-Host "锚点1 缺失，插件版本可能变了" -ForegroundColor Red; exit 2 }
if ($src -notlike "*$applyAnchor*") { Write-Host "锚点2 缺失，插件版本可能变了" -ForegroundColor Red; exit 2 }

$headBlock = @'

// ===== DSHW_BALANCE_OVERRIDE BEGIN =====
// 纯美观用途：只覆盖「界面显示」的余额数字。真实余额 / 记账 / API 扣费都不受影响。
// 递减模式：显示值 = 起始余额 - 补丁生效后累计的真实会话消耗（数据来自 /dsh-whale/usage-records.json）。
// 还原：node patch-whale-balance.mjs --restore
var DSHW_BALANCE_OVERRIDE = 2000
var DSHW_BALANCE_FIXED = false
var DSHW_BALANCE_INCLUDE_PAST = false
var DSHW_BALANCE_SPENT = 0
var DSHW_BALANCE_BASE_KEY = "dshw-balance-override-base"
function dshwBalanceCumulativeSpend(d) {
  var days = (d && d.all && Array.isArray(d.all.days)) ? d.all.days : []
  var sum = 0
  for (var i = 0; i < days.length; i++) {
    var x = days[i] || {}
    var v = (typeof x.modelTotal === "number") ? x.modelTotal : (Number(x.total) || 0)
    if (isFinite(v)) sum += v
  }
  return sum
}
function dshwBalancePollSpent() {
  try {
    fetch("/dsh-whale/usage-records.json", { cache: "no-store" })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (!d || !d.ok) return
        var cum = dshwBalanceCumulativeSpend(d)
        var raw = null
        try { raw = localStorage.getItem(DSHW_BALANCE_BASE_KEY) } catch (err) { raw = null }
        var base = (raw === null || raw === "") ? null : Number(raw)
        if (DSHW_BALANCE_INCLUDE_PAST) base = 0
        if (base === null || !isFinite(base)) {
          base = cum
          try { localStorage.setItem(DSHW_BALANCE_BASE_KEY, String(base)) } catch (err) {}
        }
        var spent = cum - base
        if (!isFinite(spent) || spent < 0) spent = 0
        DSHW_BALANCE_SPENT = spent
        try {
          if (typeof DSHW_BALANCE_OVERRIDE === "number" && isFinite(DSHW_BALANCE_OVERRIDE) && typeof state === "object" && state) {
            var shown = DSHW_BALANCE_FIXED ? DSHW_BALANCE_OVERRIDE : Math.max(0, DSHW_BALANCE_OVERRIDE - spent)
            if (state.balance !== null && shown !== state.balance) { state.balance = shown; render() }
          }
        } catch (err) {}
      })
      .catch(function () {})
  } catch (err) {}
}
try {
  setTimeout(dshwBalancePollSpent, 2000)
  setInterval(dshwBalancePollSpent, 15000)
} catch (err) {}
// ===== DSHW_BALANCE_OVERRIDE END =====
'@
$headBlock = $headBlock.Replace("var DSHW_BALANCE_OVERRIDE = 2000", "var DSHW_BALANCE_OVERRIDE = " + $n)
$headBlock = $headBlock.Replace("var DSHW_BALANCE_FIXED = false", "var DSHW_BALANCE_FIXED = " + $fixedLit)

$applyBlock = @'
// ===== DSHW_BALANCE_OVERRIDE BEGIN =====
        // display-only：替换宿主的 totalBalance，只影响 state.balance / 泡泡显示。
        if (typeof DSHW_BALANCE_OVERRIDE === "number" && isFinite(DSHW_BALANCE_OVERRIDE)) {
          nb = DSHW_BALANCE_FIXED ? DSHW_BALANCE_OVERRIDE : Math.max(0, DSHW_BALANCE_OVERRIDE - (Number(DSHW_BALANCE_SPENT) || 0))
        }
        // ===== DSHW_BALANCE_OVERRIDE END =====
'@
$applyBlock = $applyBlock -replace "`r`n", "`n"
$headBlock  = $headBlock  -replace "`r`n", "`n"

$out = $src.Replace($headAnchor, $headAnchor + $headBlock)
$out = $out.Replace($applyAnchor, $applyAnchor + $applyBlock)

# 先写临时文件做语法检查，通过才覆盖
$tmp = "$target.check.js"
[IO.File]::WriteAllText($tmp, $out, (New-Object System.Text.UTF8Encoding($false)))
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
  & $node --check $tmp
  if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -Force; Write-Host "语法检查失败，未覆盖原文件" -ForegroundColor Red; exit 4 }
  Copy-Item $tmp $target -Force; Remove-Item $tmp -Force
  Write-Host "补丁已写入，语法检查通过。" -ForegroundColor Green
} else {
  Copy-Item $tmp $target -Force; Remove-Item $tmp -Force
  Write-Host "未找到 node，已直接写入（未做语法检查）" -ForegroundColor Yellow
}

if ($Fixed) { Write-Host ("现在固定显示 " + $n + "，不会变化。") -ForegroundColor Green }
else { Write-Host ("现在起始余额 " + $n + "，会随真实消耗递减。") -ForegroundColor Green }
Write-Host "请回到 DSH 页面按 Ctrl+F5 硬刷新。"
Write-Host "还原：powershell -ExecutionPolicy Bypass -File 改余额B.ps1 -Restore" -ForegroundColor DarkGray
