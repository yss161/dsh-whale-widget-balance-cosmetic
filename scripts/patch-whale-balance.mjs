#!/usr/bin/env node
/**
 * dsh-whale-widget 余额美化补丁 v3
 * ---------------------------------------------------------------
 * 作用：**只改挂件界面显示的余额数字与「今日已用」**，并让余额随真实消耗递减。
 *      专给「接入的是没有余额接口的第三方 API」用 —— 纯美观。
 *
 * v3 修掉两个问题：
 *   ① 「今日已用」一直是 0：宿主给的是「余额差记账」口径（没有真实余额 ⇒ 恒为 0）。
 *      这里改用挂件自己账本里的本机会话消耗（usage-records.json 的 today.modelTotal）。
 *   ② 每次重启余额归零：基线原来存在 localStorage，而 DSH Web 端口每次启动都变
 *      （配置是 port: 0，实测 1656 → 1963 → 10849 → 8361 …），换端口就是换源，
 *      localStorage 直接失效。现在状态存在**挂件账本**里（settings.models.deepseek.quota.__dshwBalance），
 *      跨端口、跨重启都在。
 *
 * 扣减口径（单调递增，不会因为账本裁剪而回跳）：
 *   累计已扣 consumed 只增不减：
 *     delta = max(0, 当前累计消耗 - 上次累计消耗)
 *     consumed += delta
 *     显示余额 = 起始余额 - consumed
 *
 * 不会改变：真实扣费、账本 .dshw-usage.json、宿主自己的余额/预算/预警口径。
 *
 * 用法：
 *   node patch-whale-balance.mjs 2000                 起始余额 2000，随消耗递减（推荐）
 *   node patch-whale-balance.mjs 2000 --include-past  连补丁之前的历史消耗一起扣
 *   node patch-whale-balance.mjs 2000 --fixed         固定显示 2000，永不变化
 *   node patch-whale-balance.mjs --restore            还原成真实余额
 *   node patch-whale-balance.mjs 2000 --file <path>   指定 whale-widget.js
 *   node patch-whale-balance.mjs 2000 --dry-run       只检查不写文件
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HEAD_ANCHOR = "var BALANCE_URL = '/dsh-whale/balance.json'"
const APPLY_ANCHOR = 'var nb = Number(data.totalBalance)'
const TODAY_ANCHOR = 'state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null'

function findWidgetFiles() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const out = []
  const profiles = path.join(home, 'profiles')
  try {
    for (const name of fs.readdirSync(profiles)) {
      const p = path.join(profiles, name, 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js')
      if (fs.existsSync(p)) out.push(p)
    }
  } catch (err) { /* 没有 profiles 目录 */ }
  const extra = [
    path.join(home, 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js'),
  ]
  for (const p of extra) { try { if (fs.existsSync(p) && !out.includes(p)) out.push(p) } catch (err) {} }
  return out
}

function parseArgs(argv) {
  const opt = { amount: null, restore: false, file: null, dryRun: false, fixed: false, includePast: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--restore' || a === '-r') opt.restore = true
    else if (a === '--dry-run') opt.dryRun = true
    else if (a === '--fixed') opt.fixed = true
    else if (a === '--include-past') opt.includePast = true
    else if (a === '--file' || a === '-f') opt.file = argv[++i]
    else if (a === '--help' || a === '-h') opt.help = true
    else if (!a.startsWith('-')) opt.amount = a
  }
  return opt
}

/* ---------------- ① 文件头：常量 + 状态 + 轮询 ---------------- */
function headerBlock(n, fixed, includePast) {
  return [
    '',
    '// ===== DSHW_BALANCE_OVERRIDE BEGIN =====',
    '// 纯美观用途：只覆盖「界面显示」的余额数字与「今日已用」文案。',
    '// 真实扣费 / 账本 / API 余额都不受影响。',
    '// 显示余额 = 起始余额 - 累计已扣（累计已扣只增不减，存挂件账本里，跨端口跨重启不丢）',
    '// 还原：node patch-whale-balance.mjs --restore',
    'var DSHW_BALANCE_OVERRIDE = ' + Number(n),
    'var DSHW_BALANCE_FIXED = ' + (fixed ? 'true' : 'false'),
    'var DSHW_BALANCE_INCLUDE_PAST = ' + (includePast ? 'true' : 'false'),
    'var DSHW_BALANCE_STATE_KEY = "__dshwBalance"',
    'var DSHW_BALANCE_STATE = null',
    'var DSHW_BALANCE_CONSUMED = 0',
    'var DSHW_BALANCE_LAST_CUM = 0',
    'var DSHW_BALANCE_TODAY = 0',
    'function dshwBalanceSumDays(d) {',
    '  var days = (d && d.all && Array.isArray(d.all.days)) ? d.all.days : []',
    '  var sum = 0',
    '  for (var i = 0; i < days.length; i++) {',
    '    var x = days[i] || {}',
    '    var v = (typeof x.modelTotal === "number") ? x.modelTotal : (Number(x.total) || 0)',
    '    if (isFinite(v)) sum += v',
    '  }',
    '  return sum',
    '}',
    'function dshwBalanceReadState(cb) {',
    '  try {',
    '    fetch("/dsh-whale/usage-settings.json", { cache: "no-store" })',
    '      .then(function (r) { return r.json() })',
    '      .then(function (d) {',
    '        var st = null',
    '        try {',
    '          var q = d && d.settings && d.settings.models && d.settings.models.deepseek && d.settings.models.deepseek.quota',
    '          st = (q && q[DSHW_BALANCE_STATE_KEY]) ? q[DSHW_BALANCE_STATE_KEY] : null',
    '        } catch (err) { st = null }',
    '        if (st && typeof st === "object") DSHW_BALANCE_STATE = st',
    '        if (cb) cb()',
    '      })',
    '      .catch(function () { if (cb) cb() })',
    '  } catch (err) { if (cb) cb() }',
    '}',
    'function dshwBalanceWriteState(st) {',
    '  try {',
    '    DSHW_BALANCE_STATE = st',
    '    fetch("/dsh-whale/usage-settings.json", {',
    '      method: "PUT",',
    '      headers: { "Content-Type": "application/json" },',
    '      body: JSON.stringify({ modelSettings: { id: "deepseek", quota: (function () {',
    '        var q = {}',
    '        try {',
    '          var s = usageSet && usageSet.models && usageSet.models.deepseek && usageSet.models.deepseek.quota',
    '          if (s && typeof s === "object") q = Object.assign({}, s)',
    '        } catch (err) {}',
    '        q[DSHW_BALANCE_STATE_KEY] = st',
    '        return q',
    '      })() } }),',
    '    })',
    '      .then(function (r) { return r.json().catch(function () { return null }) })',
    '      .then(function (d) { try { if (d && d.settings) usageSet = d.settings } catch (err) {} })',
    '      .catch(function () {})',
    '  } catch (err) {}',
    '}',
    'function dshwBalanceApply() {',
    '  try {',
    '    if (typeof DSHW_BALANCE_OVERRIDE !== "number" || !isFinite(DSHW_BALANCE_OVERRIDE)) return',
    '    var base = DSHW_BALANCE_OVERRIDE',
    '    var spent = DSHW_BALANCE_FIXED ? 0 : (Number(DSHW_BALANCE_CONSUMED) || 0)',
    '    var shown = DSHW_BALANCE_FIXED ? base : Math.max(0, base - spent)',
    '    if (typeof state === "object" && state) {',
    '      if (state.balance !== null && state.balance !== shown) { state.balance = shown; render() }',
    '      if (typeof DSHW_BALANCE_TODAY === "number" && isFinite(DSHW_BALANCE_TODAY) && DSHW_BALANCE_TODAY > 0) {',
    '        if (state.todayUsage !== DSHW_BALANCE_TODAY) {',
    '          state.todayUsage = DSHW_BALANCE_TODAY',
    '          state.todayUsageCurrency = "CNY"',
    '          state.usageLabel = "本地估算"',
    '          render()',
    '        }',
    '      }',
    '    }',
    '  } catch (err) {}',
    '}',
    'function dshwBalancePollSpent() {',
    '  try {',
    '    fetch("/dsh-whale/usage-records.json", { cache: "no-store" })',
    '      .then(function (r) { return r.json() })',
    '      .then(function (d) {',
    '        if (!d || !d.ok) return',
    '        var cum = dshwBalanceSumDays(d)',
    '        var today = (d.today && typeof d.today.modelTotal === "number") ? d.today.modelTotal : 0',
    '        DSHW_BALANCE_TODAY = today',
    '        var st = DSHW_BALANCE_STATE',
    '        if (!st || typeof st.consumed !== "number" || !isFinite(st.consumed)) {',
    '          st = { base: DSHW_BALANCE_OVERRIDE, consumed: DSHW_BALANCE_INCLUDE_PAST ? cum : 0, lastCum: cum }',
    '          dshwBalanceWriteState(st)',
    '        }',
    '        if (typeof st.base === "number" && st.base !== DSHW_BALANCE_OVERRIDE) { st.base = DSHW_BALANCE_OVERRIDE }',
    '        var lastCum = (typeof st.lastCum === "number" && isFinite(st.lastCum)) ? st.lastCum : cum',
    '        var delta = cum - lastCum',
    '        if (!isFinite(delta) || delta < 0) delta = 0',
    '        // 顺序很重要：先把 lastCum 推进到当前累计，再把增量加进 consumed，最后一次性写回。',
    '        // 否则下次轮询会用同一个 lastCum 再算一次同样的增量（重复扣费）。',
    '        st.lastCum = cum',
    '        if (delta > 0) st.consumed = (Number(st.consumed) || 0) + delta',
    '        dshwBalanceWriteState(st)',
    '        DSHW_BALANCE_CONSUMED = Number(st.consumed) || 0',
    '        DSHW_BALANCE_LAST_CUM = lastCum',
    '        dshwBalanceApply()',
    '      })',
    '      .catch(function () {})',
    '  } catch (err) {}',
    '}',
    'function dshwBalanceBoot() {',
    '  try {',
    '    dshwBalanceReadState(function () {',
    '      dshwBalancePollSpent()',
    '      setTimeout(dshwBalancePollSpent, 1200)',
    '    })',
    '    setInterval(dshwBalancePollSpent, 15000)',
    '  } catch (err) {}',
    '}',
    'try { setTimeout(dshwBalanceBoot, 300) } catch (err) {}',
    '// ===== DSHW_BALANCE_OVERRIDE END =====',
  ].join('\n')
}

/* ---------------- ② 显示层：替换宿主给的余额 ---------------- */
function applyBlock() {
  return [
    '// ===== DSHW_BALANCE_OVERRIDE BEGIN =====',
    '// display-only：替换宿主的 totalBalance，只影响 state.balance / 泡泡显示。',
    'if (typeof DSHW_BALANCE_OVERRIDE === "number" && isFinite(DSHW_BALANCE_OVERRIDE)) {',
    '  var dshwSpent = DSHW_BALANCE_FIXED ? 0 : (Number(DSHW_BALANCE_CONSUMED) || 0)',
    '  nb = DSHW_BALANCE_FIXED ? DSHW_BALANCE_OVERRIDE : Math.max(0, DSHW_BALANCE_OVERRIDE - dshwSpent)',
    '}',
    '// ===== DSHW_BALANCE_OVERRIDE END =====',
  ].join('\n        ')
}

/* ---------------- ③ 「今日已用」兜底 ---------------- */
function todayBlock() {
  return [
    '// ===== DSHW_BALANCE_OVERRIDE BEGIN =====',
    '// 宿主给的是「余额差记账」口径（无真实余额 ⇒ 恒为 0）；这里用账本里的本机会话消耗。',
    'if (typeof DSHW_BALANCE_TODAY === "number" && isFinite(DSHW_BALANCE_TODAY) && DSHW_BALANCE_TODAY > 0) {',
    '  state.todayUsage = DSHW_BALANCE_TODAY',
    '  state.todayUsageCurrency = "CNY"',
    '  state.usageLabel = "本地估算"',
    '}',
    '// ===== DSHW_BALANCE_OVERRIDE END =====',
  ].join('\n        ')
}

function patchOne(file, opt) {
  const orig = file + '.orig'
  if (!fs.existsSync(orig)) {
    if (opt.dryRun) console.log('[dry-run] 会创建备份 ' + orig)
    else fs.copyFileSync(file, orig)
  }
  const src = fs.readFileSync(fs.existsSync(orig) ? orig : file, 'utf8')
  if (!src.includes(HEAD_ANCHOR)) throw new Error('锚点 1 缺失（插件版本可能已变化）：' + HEAD_ANCHOR)
  if (!src.includes(APPLY_ANCHOR)) throw new Error('锚点 2 缺失（插件版本可能已变化）：' + APPLY_ANCHOR)
  if (!src.includes(TODAY_ANCHOR)) throw new Error('锚点 3 缺失（插件版本可能已变化）：' + TODAY_ANCHOR)

  let out = src.replace(HEAD_ANCHOR, HEAD_ANCHOR + headerBlock(opt.amount, opt.fixed, opt.includePast))
  out = out.replace(APPLY_ANCHOR, APPLY_ANCHOR + '\n        ' + applyBlock())
  out = out.replace(TODAY_ANCHOR, TODAY_ANCHOR + '\n        ' + todayBlock())
  if (opt.dryRun) { console.log('[dry-run] 锚点齐全，未写文件：' + file); return }
  fs.writeFileSync(file, out, 'utf8')
  console.log('已写入：' + file)
  console.log('  模式：' + (opt.fixed ? '固定显示 ' + Number(opt.amount) : '起始 ' + Number(opt.amount) + '，随真实消耗递减'))
}

function restoreOne(file, dryRun) {
  const orig = file + '.orig'
  if (!fs.existsSync(orig)) { console.log('跳过（没有备份）：' + file); return }
  if (dryRun) { console.log('[dry-run] 会用 ' + orig + ' 还原 ' + file); return }
  fs.copyFileSync(orig, file)
  console.log('已还原：' + file)
}

const opt = parseArgs(process.argv.slice(2))
if (opt.help || (!opt.restore && opt.amount == null)) {
  console.log('用法: node patch-whale-balance.mjs <起始余额> [--fixed] [--include-past] | --restore  [--file <path>] [--dry-run]')
  process.exit(opt.help ? 0 : 1)
}

let targets = opt.file ? [opt.file] : findWidgetFiles()
targets = targets.filter((p) => { try { return fs.statSync(p).isFile() } catch (err) { return false } })
if (!targets.length) {
  console.error('没找到 whale-widget.js。请用 --file 指定路径')
  process.exit(2)
}

if (opt.restore) {
  for (const t of targets) restoreOne(t, opt.dryRun)
} else {
  const n = Number(opt.amount)
  if (!Number.isFinite(n)) { console.error('余额必须是数字，例如 2000'); process.exit(1) }
  opt.amount = n
  for (const t of targets) patchOne(t, opt)
}
console.log('')
console.log('改完请回到 DSH 页面按 Ctrl+F5 硬刷新（插件按 mtime 重读该文件，无需重启 DSH）。')
