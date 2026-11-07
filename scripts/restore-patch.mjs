#!/usr/bin/env node
/**
 * 一键恢复：检查并修复小鲸鱼挂件的余额补丁
 * ---------------------------------------------------------------
 * 插件每次升级/重装都会把 whale-widget.js 覆盖回官方原版，补丁随之消失。
 * 这个脚本负责：
 *   1. 自动找到 whale-widget.js
 *   2. 检查补丁状态（完整 / 丢失 / 残缺）
 *   3. 丢了就自动重打，并沿用上次的起始余额
 *   4. 打完做语法校验，不合格自动回滚
 *
 * 用法：
 *   node restore-patch.mjs              一键检查+修复（推荐）
 *   node restore-patch.mjs --status     只看状态，不改文件
 *   node restore-patch.mjs --base 3000  顺带把起始余额改成 3000
 *   node restore-patch.mjs --reset      清掉已扣金额，余额回到起始值
 *   node restore-patch.mjs --uninstall  彻底还原成官方原版
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const MARK = 'DSHW_BALANCE_OVERRIDE'
const HEAD_ANCHOR = "var BALANCE_URL = '/dsh-whale/balance.json'"
const APPLY_ANCHOR = 'var nb = Number(data.totalBalance)'
const TODAY_ANCHOR = 'state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null'
const DEFAULT_BASE = 2000
const CONFIG_NAME = 'balance-config.json'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const configPath = path.join(scriptDir, CONFIG_NAME)
const ledgerPath = path.join(home, '.dshw-usage.json')

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2)
const opt = { status: false, reset: false, uninstall: false, base: null }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--status') opt.status = true
  else if (a === '--reset') opt.reset = true
  else if (a === '--uninstall') opt.uninstall = true
  else if (a === '--base') opt.base = Number(argv[++i])
}

/* ---------- 找 widget 文件 ---------- */
function findWidget() {
  const out = []
  try {
    for (const name of fs.readdirSync(path.join(home, 'profiles'))) {
      const p = path.join(home, 'profiles', name, 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js')
      if (fs.existsSync(p)) out.push(p)
    }
  } catch (err) {}
  if (!out.length) {
    const p = path.join(home, 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js')
    if (fs.existsSync(p)) out.push(p)
  }
  return out
}

/* ---------- 读写配置 ---------- */
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch (err) { return {} }
}
function writeConfig(cfg) {
  try { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8') } catch (err) {}
}

/* ---------- 读挂件账本里的状态 ---------- */
function readLedgerState() {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
    const q = j && j.settings && j.settings.models && j.settings.models.deepseek && j.settings.models.deepseek.quota
    return (q && q.__dshwBalance) ? q.__dshwBalance : null
  } catch (err) { return null }
}
function clearLedgerState() {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
    const q = j && j.settings && j.settings.models && j.settings.models.deepseek && j.settings.models.deepseek.quota
    if (q && q.__dshwBalance) {
      delete q.__dshwBalance
      fs.writeFileSync(ledgerPath, JSON.stringify(j), 'utf8')
      return true
    }
  } catch (err) {}
  return false
}

/* ---------- 决定起始余额 ---------- */
function resolveBase() {
  if (Number.isFinite(opt.base)) return opt.base
  const cfg = readConfig()
  if (Number.isFinite(cfg.base)) return cfg.base
  const st = readLedgerState()
  if (st && Number.isFinite(st.base)) return st.base
  return DEFAULT_BASE
}

/* ---------- 补丁状态 ---------- */
function patchState(src) {
  const n = (src.match(new RegExp(MARK + ' BEGIN', 'g')) || []).length
  if (n === 0) return { state: 'missing', blocks: 0 }
  if (n >= 3) return { state: 'ok', blocks: n }
  return { state: 'partial', blocks: n }
}

/* ---------- 生成注入代码（与 patch-whale-balance.mjs 保持一致） ---------- */
function headerBlock(n, fixed, includePast) {
  return [
    '',
    '// ===== DSHW_BALANCE_OVERRIDE BEGIN =====',
    '// 纯美观用途：只覆盖「界面显示」的余额数字与「今日已用」文案。',
    '// 真实扣费 / 账本 / API 余额都不受影响。',
    '// 显示余额 = 起始余额 - 累计已扣（累计已扣只增不减，存挂件账本里，跨端口跨重启不丢）',
    '// 还原：node restore-patch.mjs --uninstall',
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

/* ---------- 语法校验 ---------- */
function syntaxOk(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  return r.status === 0
}

/* ---------- 主流程 ---------- */
const files = findWidget()
if (!files.length) {
  console.error('✗ 没找到 whale-widget.js')
  console.error('  确认 dsh-whale-widget 插件已安装，或设置 DSH_HOME 环境变量')
  process.exit(2)
}

const file = files[0]
const src = fs.readFileSync(file, 'utf8')
const ps = patchState(src)
const base = resolveBase()

console.log('文件：' + file)
console.log('插件版本：' + (() => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(file)), 'package.json'), 'utf8')).version } catch (e) { return '未知' }
})())
console.log('补丁状态：' + (ps.state === 'ok' ? '✓ 正常（' + ps.blocks + ' 处注入）' : ps.state === 'missing' ? '✗ 已丢失' : '⚠ 残缺（' + ps.blocks + ' 处）'))
console.log('起始余额：' + base)

const ledgerState = readLedgerState()
if (ledgerState) {
  console.log('已扣金额：' + (Number(ledgerState.consumed) || 0).toFixed(2) + '  →  当前应显示 ' + Math.max(0, base - (Number(ledgerState.consumed) || 0)).toFixed(2))
}

if (opt.status) { console.log('\n（--status：只检查，未改任何文件）'); process.exit(ps.state === 'ok' ? 0 : 1) }

/* 卸载 */
if (opt.uninstall) {
  const orig = file + '.orig'
  if (!fs.existsSync(orig)) { console.error('✗ 没有 .orig 备份，无法还原'); process.exit(3) }
  fs.copyFileSync(orig, file)
  clearLedgerState()
  console.log('\n✓ 已还原成官方原版，并清除已扣状态。请按 Ctrl+F5 刷新页面。')
  process.exit(0)
}

/* --reset：只清已扣金额 */
if (opt.reset) {
  const ok = clearLedgerState()
  console.log(ok ? '\n✓ 已清除已扣金额，下次轮询会从 ' + base + ' 重新开始扣。' : '\n已扣金额本来就是空的。')
  if (ps.state !== 'ok') console.log('⚠ 补丁本身缺失，接着会自动修复…')
  else { console.log('请按 Ctrl+F5 刷新页面。'); process.exit(0) }
}

/* 修复 / 重打 */
if (ps.state === 'ok' && !opt.reset) {
  console.log('\n✓ 补丁完好，无需修复。')
  writeConfig({ base })
  process.exit(0)
}

const orig = file + '.orig'
if (!fs.existsSync(orig) || ps.state !== 'ok') {
  // 当前文件是"干净原版"时才做备份；已有备份就保留（那是真正的原版）
  if (!fs.existsSync(orig)) {
    if (ps.state === 'missing') {
      fs.copyFileSync(file, orig)
      console.log('\n已备份官方原版 → ' + orig)
    } else {
      console.error('✗ 补丁残缺且没有原版备份，无法安全修复。')
      console.error('  建议：重装插件后再跑一次本脚本。')
      process.exit(4)
    }
  }
}

let out = src
if (ps.state !== 'missing') {
  // 残缺：从原版重建
  out = fs.readFileSync(orig, 'utf8')
}

if (!out.includes(HEAD_ANCHOR) || !out.includes(APPLY_ANCHOR) || !out.includes(TODAY_ANCHOR)) {
  console.error('✗ 锚点缺失，插件代码结构可能变了：')
  if (!out.includes(HEAD_ANCHOR)) console.error('   - ' + HEAD_ANCHOR)
  if (!out.includes(APPLY_ANCHOR)) console.error('   - ' + APPLY_ANCHOR)
  if (!out.includes(TODAY_ANCHOR)) console.error('   - ' + TODAY_ANCHOR)
  process.exit(5)
}

out = out.replace(HEAD_ANCHOR, HEAD_ANCHOR + headerBlock(base, false, false))
out = out.replace(APPLY_ANCHOR, APPLY_ANCHOR + '\n        ' + applyBlock())
out = out.replace(TODAY_ANCHOR, TODAY_ANCHOR + '\n        ' + todayBlock())

// 先写临时文件校验，通过才覆盖
const tmp = file + '.restore-check.js'
fs.writeFileSync(tmp, out, 'utf8')
if (!syntaxOk(tmp)) {
  fs.unlinkSync(tmp)
  console.error('✗ 生成的代码语法校验失败，未覆盖原文件。')
  process.exit(6)
}
fs.copyFileSync(tmp, file)
fs.unlinkSync(tmp)

writeConfig({ base })
console.log('\n✓ 补丁已恢复（起始余额 ' + base + '，随消耗递减）')
console.log('  请回到 DSH 页面按 Ctrl+F5 硬刷新。')
