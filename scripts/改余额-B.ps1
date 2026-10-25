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
$todayAnchor = "state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null"
if ($src -notlike "*$headAnchor*")  { Write-Host "锚点1 缺失，插件版本可能变了" -ForegroundColor Red; exit 2 }
if ($src -notlike "*$applyAnchor*") { Write-Host "锚点2 缺失，插件版本可能变了" -ForegroundColor Red; exit 2 }
if ($src -notlike "*$todayAnchor*") { Write-Host "锚点3 缺失，插件版本可能变了" -ForegroundColor Red; exit 2 }

$headBlock = @'

// ===== DSHW_BALANCE_OVERRIDE BEGIN =====
// 纯美观用途：只覆盖「界面显示」的余额数字与「今日已用」文案。
// 真实扣费 / 账本 / API 余额都不受影响。
// 显示余额 = 起始余额 - 累计已扣（累计已扣只增不减，存挂件账本里，跨端口跨重启不丢）
// 还原：node patch-whale-balance.mjs --restore
var DSHW_BALANCE_OVERRIDE = 2000
var DSHW_BALANCE_FIXED = false
var DSHW_BALANCE_INCLUDE_PAST = false
var DSHW_BALANCE_STATE_KEY = "__dshwBalance"
var DSHW_BALANCE_STATE = null
var DSHW_BALANCE_CONSUMED = 0
var DSHW_BALANCE_LAST_CUM = 0
var DSHW_BALANCE_TODAY = 0
function dshwBalanceSumDays(d) {
  var days = (d && d.all && Array.isArray(d.all.days)) ? d.all.days : []
  var sum = 0
  for (var i = 0; i < days.length; i++) {
    var x = days[i] || {}
    var v = (typeof x.modelTotal === "number") ? x.modelTotal : (Number(x.total) || 0)
    if (isFinite(v)) sum += v
  }
  return sum
}
function dshwBalanceReadState(cb) {
  try {
    fetch("/dsh-whale/usage-settings.json", { cache: "no-store" })
      .then(function (r) { return r.json() })
      .then(function (d) {
        var st = null
        try {
          var q = d && d.settings && d.settings.models && d.settings.models.deepseek && d.settings.models.deepseek.quota
          st = (q && q[DSHW_BALANCE_STATE_KEY]) ? q[DSHW_BALANCE_STATE_KEY] : null
        } catch (err) { st = null }
        if (st && typeof st === "object") DSHW_BALANCE_STATE = st
        if (cb) cb()
      })
      .catch(function () { if (cb) cb() })
  } catch (err) { if (cb) cb() }
}
function dshwBalanceWriteState(st) {
  try {
    DSHW_BALANCE_STATE = st
    fetch("/dsh-whale/usage-settings.json", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelSettings: { id: "deepseek", quota: (function () {
        var q = {}
        try {
          var s = usageSet && usageSet.models && usageSet.models.deepseek && usageSet.models.deepseek.quota
          if (s && typeof s === "object") q = Object.assign({}, s)
        } catch (err) {}
        q[DSHW_BALANCE_STATE_KEY] = st
        return q
      })() } }),
    })
      .then(function (r) { return r.json().catch(function () { return null }) })
      .then(function (d) { try { if (d && d.settings) usageSet = d.settings } catch (err) {} })
      .catch(function () {})
  } catch (err) {}
}
function dshwBalanceApply() {
  try {
    if (typeof DSHW_BALANCE_OVERRIDE !== "number" || !isFinite(DSHW_BALANCE_OVERRIDE)) return
    var base = DSHW_BALANCE_OVERRIDE
    var spent = DSHW_BALANCE_FIXED ? 0 : (Number(DSHW_BALANCE_CONSUMED) || 0)
    var shown = DSHW_BALANCE_FIXED ? base : Math.max(0, base - spent)
    if (typeof state === "object" && state) {
      if (state.balance !== null && state.balance !== shown) { state.balance = shown; render() }
      if (typeof DSHW_BALANCE_TODAY === "number" && isFinite(DSHW_BALANCE_TODAY) && DSHW_BALANCE_TODAY > 0) {
        if (state.todayUsage !== DSHW_BALANCE_TODAY) {
          state.todayUsage = DSHW_BALANCE_TODAY
          state.todayUsageCurrency = "CNY"
          state.usageLabel = "本地估算"
          render()
        }
      }
    }
  } catch (err) {}
}
function dshwBalancePollSpent() {
  try {
    fetch("/dsh-whale/usage-records.json", { cache: "no-store" })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (!d || !d.ok) return
        var cum = dshwBalanceSumDays(d)
        var today = (d.today && typeof d.today.modelTotal === "number") ? d.today.modelTotal : 0
        DSHW_BALANCE_TODAY = today
        var st = DSHW_BALANCE_STATE
        if (!st || typeof st.consumed !== "number" || !isFinite(st.consumed)) {
          st = { base: DSHW_BALANCE_OVERRIDE, consumed: DSHW_BALANCE_INCLUDE_PAST ? cum : 0, lastCum: cum }
          dshwBalanceWriteState(st)
        }
        if (typeof st.base === "number" && st.base !== DSHW_BALANCE_OVERRIDE) { st.base = DSHW_BALANCE_OVERRIDE }
        var lastCum = (typeof st.lastCum === "number" && isFinite(st.lastCum)) ? st.lastCum : cum
        var delta = cum - lastCum
        if (!isFinite(delta) || delta < 0) delta = 0
        // 顺序很重要：先把 lastCum 推进到当前累计，再把增量加进 consumed，最后一次性写回。
        // 否则下次轮询会用同一个 lastCum 再算一次同样的增量（重复扣费）。
        st.lastCum = cum
        if (delta > 0) st.consumed = (Number(st.consumed) || 0) + delta
        dshwBalanceWriteState(st)
        DSHW_BALANCE_CONSUMED = Number(st.consumed) || 0
        DSHW_BALANCE_LAST_CUM = lastCum
        dshwBalanceApply()
      })
      .catch(function () {})
  } catch (err) {}
}
function dshwBalanceBoot() {
  try {
    dshwBalanceReadState(function () {
      dshwBalancePollSpent()
      setTimeout(dshwBalancePollSpent, 1200)
    })
    setInterval(dshwBalancePollSpent, 15000)
  } catch (err) {}
}
try { setTimeout(dshwBalanceBoot, 300) } catch (err) {}
// ===== DSHW_BALANCE_OVERRIDE END =====
'@
$headBlock = $headBlock.Replace("var DSHW_BALANCE_OVERRIDE = 2000", "var DSHW_BALANCE_OVERRIDE = " + $n)
$headBlock = $headBlock.Replace("var DSHW_BALANCE_FIXED = false", "var DSHW_BALANCE_FIXED = " + $fixedLit)

$applyBlock = @'
// ===== DSHW_BALANCE_OVERRIDE BEGIN =====
        // display-only：替换宿主的 totalBalance，只影响 state.balance / 泡泡显示。
        if (typeof DSHW_BALANCE_OVERRIDE === "number" && isFinite(DSHW_BALANCE_OVERRIDE)) {
          var dshwSpent = DSHW_BALANCE_FIXED ? 0 : (Number(DSHW_BALANCE_CONSUMED) || 0)
          nb = DSHW_BALANCE_FIXED ? DSHW_BALANCE_OVERRIDE : Math.max(0, DSHW_BALANCE_OVERRIDE - dshwSpent)
        }
        // ===== DSHW_BALANCE_OVERRIDE END =====
'@

$todayBlock = @'
// ===== DSHW_BALANCE_OVERRIDE BEGIN =====
        // 宿主给的是「余额差记账」口径（无真实余额 ⇒ 恒为 0）；这里用账本里的本机会话消耗。
        if (typeof DSHW_BALANCE_TODAY === "number" && isFinite(DSHW_BALANCE_TODAY) && DSHW_BALANCE_TODAY > 0) {
          state.todayUsage = DSHW_BALANCE_TODAY
          state.todayUsageCurrency = "CNY"
          state.usageLabel = "本地估算"
        }
        // ===== DSHW_BALANCE_OVERRIDE END =====
'@

# 统一换行 + 缩进（片段里的 apply/today 块原本是 8 空格缩进，这里直接用）
$headBlock  = ($headBlock  -replace "`r`n", "`n")
$applyBlock = ($applyBlock -replace "`r`n", "`n")
$todayBlock = ($todayBlock -replace "`r`n", "`n")

$out = $src.Replace($headAnchor, $headAnchor + $headBlock)
$out = $out.Replace($applyAnchor, $applyAnchor + "`n        " + $applyBlock)
$out = $out.Replace($todayAnchor, $todayAnchor + "`n        " + $todayBlock)

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
