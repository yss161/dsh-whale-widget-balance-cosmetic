#!/usr/bin/env node
/**
 * dsh-whale-widget 余额显示美化补丁
 * ---------------------------------------------------------------
 * 作用：**只改挂件界面上显示的那个余额数字**。
 *      用于你接入的是「没有余额接口」的第三方 / 中转 API，
 *      挂件拿不到余额、只能显示 0.00 的场景 —— 纯美观用途。
 *
 * 不会改变：真实扣费、账本、今日已用、余额预警、今日预算。
 *
 * 用法：
 *   node patch-whale-balance.mjs 128.50            写入固定显示值
 *   node patch-whale-balance.mjs --restore         还原成真实余额
 *   node patch-whale-balance.mjs 128.50 --file <path>   指定 whale-widget.js
 *   node patch-whale-balance.mjs 128.50 --dry-run  只检查不写文件
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HEAD_ANCHOR = "var BALANCE_URL = '/dsh-whale/balance.json'"
const APPLY_ANCHOR = 'var nb = Number(data.totalBalance)'

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
  // 兜底：全局安装 / 其它常见位置
  const extra = [
    path.join(home, 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js'),
  ]
  for (const p of extra) { try { if (fs.existsSync(p) && !out.includes(p)) out.push(p) } catch (err) {} }
  return out
}

function parseArgs(argv) {
  const opt = { amount: null, restore: false, file: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--restore' || a === '-r') opt.restore = true
    else if (a === '--dry-run') opt.dryRun = true
    else if (a === '--file' || a === '-f') opt.file = argv[++i]
    else if (a === '--help' || a === '-h') opt.help = true
    else if (!a.startsWith('-')) opt.amount = a
  }
  return opt
}

function headerBlock(n) {
  return [
    '',
    '// ===== DSHW_BALANCE_OVERRIDE BEGIN =====',
    '// 仅覆盖「界面显示」的余额数字，纯美观用途；真实余额 / 记账 / 提醒都不受影响。',
    '// 还原：node patch-whale-balance.mjs --restore',
    'var DSHW_BALANCE_OVERRIDE = ' + Number(n),
    '// ===== DSHW_BALANCE_OVERRIDE END =====',
  ].join('\n')
}

function applyBlock() {
  return [
    '// ===== DSHW_BALANCE_OVERRIDE BEGIN =====',
    '// display-only：换掉宿主下发的 totalBalance，仅影响 state.balance。',
    'if (typeof DSHW_BALANCE_OVERRIDE === "number" && isFinite(DSHW_BALANCE_OVERRIDE)) nb = DSHW_BALANCE_OVERRIDE',
    '// ===== DSHW_BALANCE_OVERRIDE END =====',
  ].join('\n        ')
}

function patchOne(file, amount, dryRun) {
  const orig = file + '.orig'
  if (!fs.existsSync(orig)) {
    if (dryRun) { console.log('[dry-run] 会创建备份 ' + orig) }
    else fs.copyFileSync(file, orig)
  }
  const src = fs.readFileSync(fs.existsSync(orig) ? orig : file, 'utf8')
  if (!src.includes(HEAD_ANCHOR)) throw new Error('锚点 1 缺失（插件版本可能已变化）：' + HEAD_ANCHOR)
  if (!src.includes(APPLY_ANCHOR)) throw new Error('锚点 2 缺失（插件版本可能已变化）：' + APPLY_ANCHOR)
  let out = src.replace(HEAD_ANCHOR, HEAD_ANCHOR + headerBlock(amount))
  out = out.replace(APPLY_ANCHOR, APPLY_ANCHOR + '\n        ' + applyBlock())
  if (dryRun) { console.log('[dry-run] 语法自检通过，未写文件：' + file); return }
  fs.writeFileSync(file, out, 'utf8')
  console.log('已写入：' + file + ' -> 固定显示 ' + Number(amount))
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
  console.log('用法: node patch-whale-balance.mjs <金额> | --restore  [--file <whale-widget.js>] [--dry-run]')
  process.exit(opt.help ? 0 : 1)
}

let targets = opt.file ? [opt.file] : findWidgetFiles()
targets = targets.filter((p) => { try { return fs.statSync(p).isFile() } catch (err) { return false } })
if (!targets.length) {
  console.error('没找到 whale-widget.js。请用 --file 指定路径，例如：')
  console.error('  --file "%USERPROFILE%\\.dsh\\profiles\\desktop\\node_modules\\dsh-whale-widget\\assets\\whale-widget.js"')
  process.exit(2)
}

if (opt.restore) {
  for (const t of targets) restoreOne(t, opt.dryRun)
} else {
  const n = Number(opt.amount)
  if (!Number.isFinite(n)) { console.error('金额必须是数字，例如 128.50'); process.exit(1) }
  for (const t of targets) patchOne(t, n, opt.dryRun)
}
console.log('')
console.log('改完请回到 DSH 页面按 Ctrl+F5 硬刷新（插件按 mtime 重读该文件，无需重启 DSH）。')
