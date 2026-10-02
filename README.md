# dsh-tool-gzh-publisher

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/yuehancn/dsh-tool-gzh-publisher)

> **在 dsh 里把关并推送公众号草稿** —— 装完这个插件，你的 Agent 就能先过质量门、
> 再把稿件推进公众号草稿箱，全程不用离开对话。

公众号（WeChat Official Account）管线工具集，以 dsh 插件形式暴露给 Agent。

> **Compatibility**: built and tested against dsh `0.2.0-rc.2` (preview).
> The `apply(ctx)` plugin spec is stable; verify against your own dsh version if newer.

---

## 一行安装

```bash
dsh plugin --profile desktop add github:yuehancn/dsh-tool-gzh-publisher
```

**支持的 profile**：`desktop`（桌面版）/ `web`（Web 版）。
⚠️ 需要本机已有 `gzh_auto.py` 管线脚本，见下方「前置条件」。

它**不重新实现**微信 API —— 微信的 access_token 握手、草稿创建、发布前质量门
都在已经跑通的 `gzh_auto.py`（来自 `gzh-auto-publisher` 技能）里。本插件是一层
**类型化桥接**，把这套能力变成模型能安全调用的工具。

> 为什么不做成「直接 exec 一个脚本」？因为那样模型要自己拼 flag、自己解析中文
> 输出、自己判断成功失败。凭据类、限频的 API 一旦有第二份实现，就必然出现两个
> source of truth。这里只做：类型化参数 + 结构化输出 + 稳定的路径配置。

---

## 安装

```bash
dsh plugin --profile desktop add github:yuehancn/dsh-tool-gzh-publisher
```

Replace `desktop` with your own profile name. **This plugin needs external setup**
(a publisher script + an account registry) — see below.

> ⚠️ **本插件不是开箱即用**。它桥接的 `gzh_auto.py` 与 `accounts.json` 是另一个
> 仓库/技能的内容。装完插件后必须自己配好这三个路径，否则工具会明确报
> `gzh: publisher script not found at "…"`。

---

## 🔐 权限与隐私

**这一节很重要 —— 本插件会接触微信发布凭据。**

| 项目 | 说明 |
|---|---|
| **凭据读取** | 插件**本身不读取凭据**。它把工作委托给 `gzh_auto.py`，由后者从你的 `env_file` 里读 `WECHAT_APPID` / `WECHAT_APPSECRET`，换取 access_token |
| **凭据传输** | access_token 只发给微信官方接口（`api.weixin.qq.com`）。**不经过任何第三方** |
| **网络访问** | 仅访问微信官方 API。离线工具（`gzh_accounts` / `gzh_validate` / `gzh_check`）**完全不出网** |
| **数据外发** | 无遥测。文章内容只在你调用 `gzh_push_draft` 时发给微信 |
| **文件读取** | 读你指定的稿件 `.md` 文件、`accounts.json`、以及 `env_file` |
| **文件写入** | **无**。本插件不写任何文件 |
| **进程启动** | 通过 `execFile` 调用你配置的 `pythonPath` 执行 `scriptPath`。⚠️ 这是本插件唯一会启动的进程 |
| **生命周期脚本** | **无** `preinstall` / `postinstall` / `prepare`。安装时不会跑任何代码 |
| **运行时依赖** | 仅 `@deepseek-ai/schemastery`（配置校验）。其余为 peer，由 dsh 提供 |

⚠️ **发布是不可逆的对外动作**。`gzh_push_draft` 只推**草稿箱**、不发布，
最终「发布」仍需人工点击 —— 这是有意设计。

---

## 工具一览

| 工具 | 背后命令 | 联网 | 作用 |
|---|---|---|---|
| `gzh_accounts` | 直接读 `accounts.json` | 否 | 列出本机可发布的公众号，含定位/关键词/工作目录 |
| `gzh_validate` | `validate --account --file` | 否 | 对稿件跑发布门（字数/金句/emoji/AI 腔/结尾），**不碰网络** |
| `gzh_check` | `check --account` | 否 | 账号配置体检：必填字段、磁盘路径、env 里有没有 APPID/SECRET |
| `gzh_push_draft` | `push --account --file [--title] [--digest]` | 是 | 先过门再推草稿箱；**不发布**，人还得点「发布」 |
| `gzh_verify` | `verify --account` | 是 | 真实凭据握手，取 access_token。唯一会鉴权的工具 |

工具描述里显式标了联网与否，因为模型不该在只想体检配置时误触发一次鉴权。

---

## 前置条件

本插件需要三样外部东西：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `scriptPath` | `…/gzh-auto-publisher/scripts/gzh_auto.py` | 被桥接的发布脚本 |
| `pythonPath` | 本机 3.13.12 venv python | 跑脚本的解释器 |
| `accountsPath` | `…/gzh-auto-publisher/accounts.json` | 账号注册表 |

`accounts.json` 的每个条目形如：

```json
{
  "我的公众号": {
    "name": "我的公众号",
    "positioning": "账号定位一句话",
    "keywords": ["关键词1", "关键词2"],
    "workdir": "C:/path/to/drafts",
    "env_file": "C:/path/to/.env",
    "min_cjk": 1500,
    "max_cjk": 2600,
    "min_gold": 2,
    "ending": "…我的公众号",
    "author": "作者名"
  }
}
```

> `env_file` 指向一个含 `WECHAT_APPID` / `WECHAT_APPSECRET` 的文件。
> ⚠️ **该文件不要提交到任何仓库**。

---

## 安装（手工，本机开发用）

<details>
<summary>展开：不走 CLI 的手工装法</summary>

### 1. 插件本体

放在 `~/.dsh/plugins/dsh-tool-gzh-publisher/`：

```
package.json
cordis.patch.yml
lib/index.js
```

### 2. 激活（两处都要改，缺一不可）

`~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dependencies": {
    "dsh-tool-gzh-publisher": "link:C:/Users/<你>/.dsh/plugins/dsh-tool-gzh-publisher"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-tool-gzh-publisher"]
    }
  }
}
```

只写 `dependencies` = 装了但**没启用**。`bundles` 才是启用开关。

### 3. node_modules 链接

dsh 加载时从 profile 的 `node_modules` 读包，所以需要一条 junction：

```bat
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-tool-gzh-publisher" ^
          "%USERPROFILE%\.dsh\plugins\dsh-tool-gzh-publisher"
```

### 4. profile patch 填配置

`~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加：

```yaml
- id: tool-gzh-publisher
  config:
    scriptPath: <你的 gzh_auto.py 绝对路径>
    pythonPath: <你的 python 解释器绝对路径>
    accountsPath: <你的 accounts.json 绝对路径>
    timeoutMs: 300000
```

> `- id: tool-gzh-publisher` 在这里是**按 id 覆盖已存在的行**（bundle 已经声明过
> 这一行）。新行必须写在 `cordis.patch.yml` 的 `- insert:` 里，否则报
> `patch: entry "xxx" not found`。

</details>

---

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `scriptPath` | 无（需自配） | 被桥接的发布脚本绝对路径 |
| `pythonPath` | 系统 python | 跑脚本的解释器 |
| `accountsPath` | 无（需自配） | 账号注册表绝对路径 |
| `timeoutMs` | `180000` | `gzh_push_draft` 的调用预算 |
| `accounts` / `validate` / `check` / `push` / `verify` | `true` | 逐工具开关，可关掉不想暴露的 |

---

## 验证

三个探针（`.probe/`，为开发期产物，正式交付可删）：

```bash
node .probe/verify-load.mjs    # 模块能否被 dsh 加载、5 个工具是否注册、开关是否生效
node .probe/behaviour.mjs      # classify 映射全覆盖 + 真实脚本端到端
node .probe/live.mjs           # 真实稿件跑门 + 真实微信 API
node .probe/live2.mjs          # 从「已安装路径」加载，跑真凭据握手
```

本机实测结论：

- `verify-load` **PASS** — 5 工具注册，空配置默认值正确，`push:false, verify:false`
  时正确降为 3 个工具
- `behaviour` **全 PASS** — `exit0+✅→ok`、`exit1+❌→fail`、`exit0但含❌→fail`、
  详情原文保留；真实脚本对 4 字草稿给出真实判词
  （`CJK=4（要求 1500-2600） | 金句=0（≥2） | 结尾错误`）
- `live` — 三篇历史稿件全部 `ok=false`（**这是脚本的真实意见，不是插件 bug**）
- `live2` — 从安装路径加载成功；`gzh_check` 报配置完整；`gzh_verify` **真实取到
  token**（`✅ 授权 OK（token 前缀 108_vH…）`）

dsh 自身加载验证：

```bash
# 需要 ELECTRON_RUN_AS_NODE=1；--dump-config 是顶层 flag，不是 plugin 子命令
ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" \
  "resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile web --dump-config | grep -A2 "== dsh-tool-gzh-publisher"
```

输出：

```
# == dsh-tool-gzh-publisher
- id: tool-gzh-publisher
  name: dsh-tool-gzh-publisher
```

---

## 坑位备忘

1. **`--dump-config` 是顶层 flag**。`dsh plugin --profile web dump-config` 会把
   `dump-config` 当成 pnpm 参数透传，然后报 `'pnpm' 不是内部或外部命令`。
   正确写法：`dsh --profile web --dump-config`。
2. **必须 `ELECTRON_RUN_AS_NODE=1`**，且用桌面版的 exe 跑 asar 里的 `bin.js`。
   裸 node 读不了 asar 路径（`MODULE_NOT_FOUND`）；不带该变量则 exe 会试图开窗口
   并吞掉 stdout（表现为「rc=0 但输出 2 字节」）。
3. **`gzh_check` 不是「列草稿箱」**。它检查的是账号**配置**。真正的草稿列表要走
   微信后台。最初我把工具起名叫 `gzh_drafts` 并写成「列出草稿箱」，读脚本源码
   （`cmd_check` 在 `gzh_auto.py:310`）后改正为 `gzh_check`。
4. **中文输出必须设 `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`**，否则 Windows
   默认 OEM 代码页会把账号名、标题打成乱码。插件在 `runScript()` 里已设。
5. **`classify()` 不能只看退出码**。脚本存在「exit 0 但输出里带 ❌」的情况
   （部分判词先打 ✅ 再打 ❌）。判据是 `code===0 && !/❌/`。
6. **`accounts.json` 的中文键**（账号名常为中文）在 JSON 里是 UTF-8，读取时要显式
   `encoding: "utf8"`，否则在 GBK 默认环境下会抛解码错。