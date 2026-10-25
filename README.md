# dsh-whale-widget 余额美化补丁

> 让 [小鲸鱼挂件](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的余额栏显示一个**好看的假数字**，
> 并且**随着对话消耗正常往下掉**，专门给「接的是没有余额接口的第三方 API」的场景用。

## 这是干什么的

DSH 的小鲸鱼挂件（`dsh-whale-widget`）会去 `api.deepseek.com/user/balance` 或者 DSH 账号态读余额。
如果你接的是下面这些**没有余额接口**的服务，挂件就永远显示 `¥ 0.00`，每个小时都停在同一个数上：

- WorkBuddy / 各种 OpenAI 兼容中转站（实测 `/v1/dashboard/billing/*`、`/v1/credits`、`/api/user/self` 全是 404）
- 阿里云 MaaS、火山方舟这类只有 chat 接口的网关
- 硅基流动、OpenAI、Gemini、xAI 等**官方已下线**余额接口的厂商
- 自建 Ollama / vLLM / LiteLLM

这个补丁做了两件事：

1. **换掉显示的数字** —— 你给一个起始余额，比如 `2000`；
2. **让它自己往下掉** —— 每 15 秒拉一次挂件自己的用量记录，把补丁生效后的真实会话消耗从余额里减掉。

于是泡泡上的数字会像真的在扣费一样递减（`2000.00 → 1999.63 → 1998.87 …`）。

> ⚠️ **纯美观用途**。这个数字不对应任何真实账户余额，**也不能**用来判断还能用多久。
> 它只是把「今天花了多少」从挂件自己的账本里减给你看。
>
> 如果你的厂商**有**余额接口（New API / One API 等），请直接用挂件自带的
> 「添加模型 → OpenAI 兼容中转站」模板读真实余额，不需要这个补丁。

## 两种模式

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| 递减（默认） | 起始余额 − 补丁生效后的累计消耗 | 想要「余额在正常扣掉」的观感 |
| 固定（`--fixed`） | 永远显示你填的那个数 | 只想要个漂亮数字，不在乎变化 |

递减模式用 `localStorage` 记一个基线：**只为将来新产生的消耗扣数**。
首次打补丁时历史消耗不算进去（那是已经花掉的），想连历史一起扣就加 `--include-past`。

## 它不动什么

| 项目 | 是否受补丁影响 |
| --- | --- |
| 挂件泡泡上的余额数字 | ✅ 改成你填的值 |
| 挂件面板里的余额 | ✅ 同上 |
| 真实 API 扣费 | ❌ 完全无关 |
| 小鲸鱼记账账本 `.dshw-usage.json` | ❌ 不动 |
| 今日已用 / 近 7 天 | ❌ 不动 |
| 余额预警 | ⚠️ 按**显示值**判断（因为值已被替换）—— 把假数字设得高于预警阈值即可避免误报 |
| 今日预算 | ❌ 仍按真实金额判断 |

补丁打在**前端** `whale-widget.js` 的 `refresh()` 里，也就是「宿主已经把结果发过来之后」的位置：

```js
var nb = Number(data.totalBalance)
// ===== DSHW_BALANCE_OVERRIDE BEGIN =====
if (typeof DSHW_BALANCE_OVERRIDE === "number" && isFinite(DSHW_BALANCE_OVERRIDE)) nb = DSHW_BALANCE_OVERRIDE
// ===== DSHW_BALANCE_OVERRIDE END =====
```

**为什么不去改宿主侧**：宿主 `getBalance()` 的顺序是「先 `recordLedgerUsage(totalBalance)` 记观测 → 再 `publicBalance()` 出数字」，
在宿主改会导致「今日已用」的余额差记账被污染，还会一直弹「待核对余额调整」。改在前端则完全隔离。

## 安装 / 使用

需要 Node.js（DSH 用户机器上一般都有）。

### 1. 打补丁（递减模式，推荐）

```bash
node scripts/patch-whale-balance.mjs 2000
```

只想要个固定数字：

```bash
node scripts/patch-whale-balance.mjs 2000 --fixed
```

连打补丁之前的历史消耗一起扣掉：

```bash
node scripts/patch-whale-balance.mjs 2000 --include-past
```

脚本会自动在 `$DSH_HOME/profiles/*/node_modules/dsh-whale-widget/assets/` 下找到 `whale-widget.js`
（默认 `~/.dsh`，Windows 是 `C:\Users\<你>\.dsh`）。

只有一个 profile 时不用管；想指定文件就加 `--file`：

```bash
# Windows
node scripts/patch-whale-balance.mjs 128.50 --file "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-whale-widget\assets\whale-widget.js"

# macOS / Linux
node scripts/patch-whale-balance.mjs 128.50 --file ~/.dsh/profiles/desktop/node_modules/dsh-whale-widget/assets/whale-widget.js
```

### 说明：余额预警也会读这个数字

补丁替换的是 `nb` 之后紧接着就调用的 `checkUsageAlerts(nb, ...)`，
所以「余额 ≤ N 时提醒」比较的也是你填的假数字。
把假数字设得大于预警阈值（默认 50）就不会误报；真实余额是 0 时本来也会一直触发。

### 2. 硬刷新页面

回到 DSH 页面按 **Ctrl+F5**（macOS 是 **Cmd+Shift+R**）。
插件每次请求都会按 mtime 重读 `whale-widget.js`（`lib/index.js:684-700`），**不需要重启 DSH**。

### 3. 改数字 / 换模式

再跑一次就行，脚本每次都从 `.orig` 备份重写，**不会叠加两层补丁**：

```bash
node scripts/patch-whale-balance.mjs 888.00
node scripts/patch-whale-balance.mjs 888.00 --fixed
```

换了数字之后，浏览器里记的消耗基线还在，所以会从「新起始值 − 已扣掉的那部分」继续显示。
想从零开始算，在浏览器控制台执行 `localStorage.removeItem('dshw-balance-override-base')` 再刷新。

### 4. 还原成真实余额

```bash
node scripts/patch-whale-balance.mjs --restore
```

还原用的是首次打补丁时留下的 `whale-widget.js.orig`，**逐字节恢复原样**（实测 SHA256 一致）。

### 5. 只检查不写文件

```bash
node scripts/patch-whale-balance.mjs 2000 --dry-run
```

### Windows 免 Node 版

仓库里还有一份纯 PowerShell 实现（`scripts/改余额-B.ps1`），不需要装 Node：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\改余额-B.ps1 2000
powershell -ExecutionPolicy Bypass -File scripts\改余额-B.ps1 2000 -Fixed
powershell -ExecutionPolicy Bypass -File scripts\改余额-B.ps1 -Restore
```

## 安全性

- 打补丁前会先备份成 `whale-widget.js.orig`（首次），之后所有操作都以它为基准。
- 只在两个已知锚点上插入代码，锚点找不到就**报错退出**，绝不乱改文件。
- 不改任何商品代码逻辑，改动全部夹在 `DSHW_BALANCE_OVERRIDE BEGIN/END` 注释之间，方便人工核验。
- 不需要任何网络请求、不需要 API key、不读取任何凭据。

## Windows 权限提示

如果脚本报 `EPERM` / `Access denied`，说明当前终端没有那个目录的写权限。
**用普通 PowerShell / cmd 窗口跑**（不要在受限沙箱里跑），或者把 DSH 完全关掉再执行。

## 插件升级后

`pnpm add` / 重装会把 `node_modules` 下的文件覆盖掉，补丁随之消失。
重新跑一次 `patch-whale-balance.mjs` 即可；如果升级后报「锚点缺失」，
说明上游改了代码结构，去 `whale-widget.js` 里搜 `var nb = Number(data.totalBalance)` 手动确认新锚点再提 issue。

##  Alternatives

不想改文件的话，挂件本身支持**手动额度**，可以零侵入地显示一个自定义数字：

1. 点小鲸鱼 → 底部「- = 小鲸鱼记账 = -」
2. `DeepSeek（内置）` → **设置** → **额度（订阅/资源包）**
3. 单位选 **金额（元）**、已用来源 **手动填写**、总量填你想要的值 → 保存
4. 主菜单 → 「按压泡泡设置」→ 从「可选模块」把 **额度·DeepSeek** 拖进泡泡
5. 该模块「内容」填 `¥{quota_left}`

好处是不会被升级覆盖；代价是要把原来的「总余额」模块删掉。

## 许可

MIT。仅修改你自己的本地插件文件，不重分发上游代码。
