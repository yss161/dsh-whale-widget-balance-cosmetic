#!/usr/bin/env node
/**
 * dsh-whale-widget 余额显示美化补丁
 * ---------------------------------------------------------------
 * 作用：**只改挂件界面上显示的那个余额数字**，并让它按真实消耗逐轮递减，
 *      看起来像真的在扣费。专给「接入的是没有余额接口的第三方 API」用 —— 纯美观。
 *
 * 不会改变：真实扣费、账本 .dshw-usage.json、今日已用、近 7 天。
 *
 * 用法：
 *   node patch-whale-balance.mjs 2000                起始余额 2000，随消耗递减（推荐）
 *   node patch-whale-balance.mjs 2000 --include-past 连补丁之前的历史消耗一起扣掉
 *   node patch-whale-balance.mjs 2000 --fixed        固定显示 2000，永不变化
 *   node patch-whale-balance.mjs --restore           还原成真实余额
 *   node patch-whale-balance.mjs 2000 --file <path>  指定 whale-widget.js
 *   node patch-whale-balance.mjs 2000 --dry-run      只检查不写文件
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HEAD_ANCHOR = "var BALANCE_URL = '/dsh-whale/balance.json'"
const APPLY_ANCHOR = 'var nb = Number(data.totalBalance)'
const END_ANCHOR = 'try { dshwTryStart(true) } catch (err) {}'

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

/* ---------- ① 文件头：常量 + 消耗统计轮询 ---------- */
function headerBlock(n, fixed, includePast) {
  return [
    '',
    '// ===== DSHW_BALANCE_OVERRIDE BEGIN =====',
    '// 纯美观用途：只覆盖「界面显示」的余额数字。真实余额 / 记账 / API 扣费都不受影响。',
    '// 递减模式：显示值 = 起始余额 - 补丁生效后累计的真实会话消耗（数据来自 /dsh-whale/usage-records.json）。',
    '// 还原：node patch-whale-balance.mjs --restore',
    'var DSHW_BALANCE_OVERRIDE = ' + Number(n),
    'var DSHW_BALANCE_FIXED = ' + (fixed ? 'true' : 'false'),
    'var DSHW_BALANCE_INCLUDE_PAST = ' + (includePast ? 'true' : 'false'),
    'var DSHW_BALANCE_SPENT = 0',
    'var DSHW_BALANCE_BASE_KEY = "dshw-balance-override-base"',
    'function dshwBalanceCumulativeSpend(d) {',
    '  var days = (d && d.all && Array.isArray(d.all.days)) ? d.all.days : []',
    '  var sum = 0',
    '  for (var i = 0; i < days.length; i++) {',
    '    var x = days[i] || {}',
    '    var v = (typeof x.modelTotal === "number") ? x.modelTotal : (Number(x.total) || 0)',
    '    if (isFinite(v)) sum += v',
    '  }',
    '  return sum',
    '}',
    'function dshwBalancePollSpent() {',
    '  try {',
    '    fetch("/dsh-whale/usage-records.json", { cache: "no-store" })',
    '      .then(function (r) { return r.json() })',
    '      .then(function (d) {',
    '        if (!d || !d.ok) return',
    '        var cum = dshwBalanceCumulativeSpend(d)',
    '        var raw = null',
    '        try { raw = localStorage.getItem(DSHW_BALANCE_BASE_KEY) } catch (err) { raw = null }',
    '        var base = (raw === null || raw === "") ? null : Number(raw)',
    '        if (DSHW_BALANCE_INCLUDE_PAST) base = 0',
    '        if (base === null || !isFinite(base)) {',
    '          base = cum',
    '          try { localStorage.setItem(DSHW_BALANCE_BASE_KEY, String(base)) } catch (err) {}',
    '        }',
    '        var spent = cum - base',
    '        if (!isFinite(spent) || spent < 0) spent = 0',
    '        DSHW_BALANCE_SPENT = spent',
    '        try {',
    '          if (typeof DSHW_BALANCE_OVERRIDE === "number" && isFinite(DSHW_BALANCE_OVERRIDE) && typeof state === "object" && state) {',
    '            var shown = DSHW_BALANCE_FIXED ? DSHW_BALANCE_OVERRIDE : Math.max(0, DSHW_BALANCE_OVERRIDE - spent)',
    '            if (state.balance !== null && shown !== state.balance) { state.balance = shown; render() }',
    '          }',
    '        } catch (err) {}',
    '      })',
    '      .catch(function () {})',
    '  } catch (err) {}',
    '}',
    'try {',
    '  setTimeout(dshwBalancePollSpent, 2000)',
    '  setInterval(dshwBalancePollSpent, 15000)',
    '} catch (err) {}',
    '// ===== DSHW_BALANCE_OVERRIDE END =====',
  ].join('\n')
}

/* ---------- ② 显示层：把宿主给的 totalBalance 换成我们的数 ---------- */
function applyBlock() {
  return [
    '// ===== DSHW_BALANCE_OVERRIDE BEGIN =====',
    '// display-only：替换宿主的 totalBalance，只影响 state.balance / 泡泡显示。',
    'if (typeof DSHW_BALANCE_OVERRIDE === "number" && isFinite(DSHW_BALANCE_OVERRIDE)) {',
    '  nb = DSHW_BALANCE_FIXED ? DSHW_BALANCE_OVERRIDE : Math.max(0, DSHW_BALANCE_OVERRIDE - (Number(DSHW_BALANCE_SPENT) || 0))',
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

  let out = src.replace(HEAD_ANCHOR, HEAD_ANCHOR + headerBlock(opt.amount, opt.fixed, opt.includePast))
  out = out.replace(APPLY_ANCHOR, APPLY_ANCHOR + '\n        ' + applyBlock())
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
