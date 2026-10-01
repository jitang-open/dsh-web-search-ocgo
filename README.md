# dsh-web-search-ocgo

自研的 DeepSeek Harness 网页搜索 provider：**走 OpenCode Go**（自动注入
`x-opencode-session`），并补上官方 provider 没有的失败回退、查询缓存、
结果总结与设置页。

- **provider id**：`opencode-go`
- **loader entry id**：`web-search-ocgo`
- **包名**：`dsh-web-search-ocgo`
- **依赖面**：只 import `@deepseek-ai/schemastery` 一个外部包

---

## 为什么自研

原先用的第三方 fork `dsh-web-search-opencode-go` 有四个硬伤：

1. **加载即崩** —— 它静态 import 了 `installSettingsSection`，而 DSH `0.1.7-rc.2`
   的 `@deepseek-ai/dsh-settings` 没有这个导出，整个 provider 无法加载。
2. **靠旧版本残留侥幸解析** —— 它 import 的 `@deepseek-ai/dsh-*` 从它自己的目录
   根本解析不到，是靠 `~/.dsh/profiles/node_modules/@deepseek-ai/` 里指向
   **dsh 0.1.5-rc.3** 的旧 symlink 才加载起来的（详见「为什么不 import dsh 包」）。
3. **代码是官方 provider 的 drop-in fork**，官方升级拿不到好处。
4. **本地补丁不持久**，任何 `pnpm install` 都会覆盖。

本插件从零重写，并保持对外行为兼容。

---

## 与官方 provider 的差异

| 能力 | 官方 `dsh-web-search-deepseek` | 本插件 |
|---|---|---|
| 端点 | `api.deepseek.com/anthropic/v1` | **OpenCode Go** `opencode.ai/zen/go/v1` |
| 可用模型 | 只认 `deepseek-flash` / `deepseek-v4-pro` | 只认 `deepseek-v4-flash` / `deepseek-v4.1-flash` |
| 会话头 | — | 自动注入 `x-opencode-session` + `x-opencode-client` |
| **`result.content`** | **完全不填**（实测摘要覆盖率 0%） | 取响应 `text` 块（模型总结），默认截断 2000 字符 |
| 查询缓存 | 无 | TTL 默认 5 分钟 / LRU 50，命中即 0 token |
| 失败回退 | 无 | Go 端点重试耗尽后改打官方端点（默认开） |
| 重试 | 无 | 429 / 5xx / 网络错误退避重试（默认 1 次） |
| 日期规范化 | 原样透传 `page_age` | 规范成 ISO-8601；解析不出来就丢弃而不是塞假日期 |
| 设置页 | 官方定制卡片（绑定 `web-search-deepseek`） | 自带（注册 `plugins.bundle.config`） |
| 会话事件 | 只有请求事件 | **也只有请求事件**（响应统计走 logger，见下） |
| 外部依赖 | 多个 `@deepseek-ai/dsh-*` | **只有 `@deepseek-ai/schemastery`** |

### 为什么不写响应事件（一个会让整份日志打不开的坑）

早期版本额外写了一个自定义事件 `web/ocgo-search-response`（延迟 / token /
结果数 / 缓存命中 / 是否回退）。结果**一条记录就足以让整份会话日志拒绝加载**：

```
历史加载失败：session "..." contains event type "web/ocgo-search-response" (seq 969)
unknown to this harness and not marked ignorable; refusing to interpret the log
```

根因有两层：

1. harness 的读路径（`dsh-session-persistence` 的 `validateStoredEvents`）会拒绝任何
   不在 `KNOWN_SESSION_EVENT_TYPES` 里、又没标 `ignorable: true` 的事件类型 ——
   这是**故意**的保守设计：无法判断"省略该事件是否安全"时，宁可整体拒绝，
   也不要静默重建一个被掏空的会话。
2. 但写侧 `Session.append(type, data, ...opts)` **只接受 `surfaceOp` /
   `sourceEventSeqs`，没有 `ignorable` 的入口** —— 仓库外插件其实没有正规途径
   写"可忽略事件"。官方 provider 同样只写请求事件，不写响应事件。

所以本插件的响应统计改走 `logger.info`（没有 logger 服务时退化为 `console.log`），
**不再进会话日志**。`bin/doctor.mjs` 会主动扫描历史日志，把旧版留下的未标记事件
扫出来并给出修法。

如果你确实需要把响应统计写进会话日志，唯一安全的做法是给 `Session.append`
补上 `ignorable` 支持（改全局 `@deepseek-ai/dsh-session`，pnpm 重装或升级会覆盖），
并让插件传 `{ ignorable: true }`。本插件不采用：补丁维护成本高于这点诊断数据的收益。

### 一个反直觉的实测结论：`max_uses` 不影响成本

32 次请求实测（见 `bench/maxuses-report.md`）：`max_uses` 从 5 降到 2，
**总 prompt 恒定在 ~8.1k**，结果条数也不变。根因是每次请求实际只发起
**1 次** `web_search`（`usage.server_tool_use.web_search_requests` 恒为 1），
`max_uses` 是上限而非目标值，从未被触及。

所以默认值保持 **5**；省额度靠**查询缓存**，不是下调 `max_uses`。

---

## 安装

### 1. 准备依赖链接

本插件只依赖 `@deepseek-ai/schemastery`，需要让它能被解析：

```bash
ln -sfn ~/.dsh/profiles/web/node_modules/@deepseek-ai/schemastery \
        node_modules/@deepseek-ai/schemastery
```

### 2. 挂进 profile

```bash
ln -sfn "$PWD" ~/.dsh/profiles/web/node_modules/dsh-web-search-ocgo
```

### 3. 登记 bundle

在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里加上
`dsh-web-search-ocgo`，并在 `dependencies` 里加：

```json
"dsh-web-search-ocgo": "link:/Users/mac/Documents/workspace/创造模式/dsh-web-search-ocgo"
```

### 4. 清理旧链路

从 `~/.dsh/profiles/web/cordis.patch.yml` 删掉旧的 `web-search-opencode-go` 段，
并从 `dsh.profile.bundles` 移除 `dsh-web-search-opencode-go`。

### 5. 重启

```bash
dsh web
```

重启后日志里应出现：

```
[web-search-ocgo] 已装载 provider id=opencode-go endpoint=https://opencode.ai/zen/go/v1 model=deepseek-v4.1-flash fallback=deepseek-flash
```

### 验证

```bash
dsh --profile web --dump-config | grep -A5 "id: web$"      # searchProvider 应为 opencode-go
node scripts/check.mjs                                     # 清单自检
node --test test/*.test.js                                 # 单元测试
node bin/doctor.mjs                                        # 一键诊断
```

---

## 配置

### 图形界面

「设置 → 插件」→ 打开 `dsh-web-search-ocgo` → 配置页。
改动在**失焦或回车**时立即保存，写入 profile 的 `cordis.patch.yml`。

### YAML

也可以在 `~/.dsh/profiles/web/cordis.patch.yml` 里写：

```yaml
- id: web-search-ocgo
  name: dsh-web-search-ocgo
  config:
    apiKeyEnv: OPENCODE_API_KEY
    baseURL: https://opencode.ai/zen/go/v1
    model: deepseek-v4.1-flash
    fallbackEnabled: true
    cacheTtlMs: 300000
    answerMaxChars: 2000
```

所有字段都有 schema 默认值，写多少覆盖多少。

### 主要配置项

| 字段 | 默认值 | 说明 |
|---|---|---|
| `apiKeyEnv` | `OPENCODE_API_KEY` | 凭据中心里的密钥名 |
| `baseURL` | `https://opencode.ai/zen/go/v1` | Go 端点（不含 `/messages`） |
| `model` | `deepseek-v4.1-flash` | Go 端点只认 `deepseek-v4-flash` / `deepseek-v4.1-flash` |
| `maxUses` | `5` | **实测对成本无影响**，不建议下调 |
| `sessionId` | 空（每次启动随机） | 固定会话 id；实测缓存命中不依赖它 |
| `fallbackEnabled` | `true` | Go 失败后回退官方端点（消耗 DeepSeek 余额） |
| `fallbackModel` | `deepseek-flash` | 官方端点只认 `deepseek-flash` / `deepseek-v4-pro` |
| `cacheEnabled` / `cacheTtlMs` / `cacheMaxEntries` | `true` / `300000` / `50` | 查询缓存 |
| `answerMaxChars` | `2000` | `result.content` 截断；**0 = 不返回** |
| `snippetMaxChars` | `300` | 单条摘要截断 |
| `retryCount` | `1` | 429 / 5xx / 网络错误的重试次数 |

---

## 为什么不 import dsh 包

实测：从插件自己的目录，`@deepseek-ai/dsh-*` **一个都解析不到**
（8 个里只有 `schemastery` 能解析）：

```
import FAIL @deepseek-ai/dsh-web              ERR_MODULE_NOT_FOUND
import FAIL @deepseek-ai/dsh-credentials      ERR_MODULE_NOT_FOUND
import FAIL @deepseek-ai/dsh-session          ERR_MODULE_NOT_FOUND
import OK   @deepseek-ai/schemastery
```

把同样的静态 import 写进一个 entry，dsh 日志会出现
`failed to import` / `1 entry did not activate`。

那上游 fork 为什么能加载？因为 Node 从
`~/.dsh/profiles/web/node_modules/dsh-web-search-opencode-go/` 向上查找时会命中
**`~/.dsh/profiles/node_modules/@deepseek-ai/`** —— 那里有 242 个 symlink，
全部指向 **dsh `0.1.5-rc.3`** 的旧安装，而不是当前运行的 `0.1.7-rc.2`。
它一直在用旧版本的 `WebError` / `credentialRef` 跑，是一次随时会坏的版本错配。

**本插件的对策**：依赖面压到最小，只 import `schemastery`。其余契约全部经 `ctx` 取
（`ctx.get('credentials')`、`ctx.get('agents')`），错误对象按 `HarnessError` 的
形状手工构造（`class extends Error { readonly code }`，见 `lib/errors.js`），
`process.env` 兜底 launch environment。

好处：插件可以放在任意目录，也不受 dsh 升级的版本错配影响。

---

## 卸载与回滚

### 临时回滚到官方链路（不卸载）

在「设置 → 插件」里把 `web` 这一行的 `searchProvider` 改回 `deepseek-official`，
重启即可。官方 provider 一直留在注册表里，就是为这个逃生舱准备的。

### 完全卸载

1. 从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 移除 `dsh-web-search-ocgo`
2. 删除 `cordis.patch.yml` 里 `web-search-ocgo` 段，并把 `web` 的 `searchProvider`
   改回 `deepseek-official`
3. 删除 `~/.dsh/profiles/web/node_modules/dsh-web-search-ocgo` 这个链接
4. 重启 `dsh web`

---

## 开发

```bash
node scripts/check.mjs            # 清单自检（字段、exports、语法、依赖面）
node --test test/*.test.js        # 单元测试（40 项）
node bin/doctor.mjs               # 诊断：凭据 / 配置 / 依赖 / 语法 / 会话日志遗留污染
node bin/doctor.mjs --probe       # 额外真发一次搜索（会花钱）
node bench/dump-response.mjs "查询词"   # dump 原始响应结构（需要凭据）
node bench/maxuses-bench.mjs      # 复现 max_uses 曲线
```

### 目录

| 路径 | 说明 |
|---|---|
| `index.js` | host 半：Config schema + 装载自检 + 注册 provider |
| `client.js` | 浏览器半：设置页（手写 `__ModuleLoader__` bundle，无构建步骤） |
| `lib/provider.js` | provider 本体：请求、重试、回退、结果映射 |
| `lib/cache.js` | 查询缓存（TTL + LRU） |
| `lib/errors.js` | 与 `HarnessError` 同形状的错误 |
| `lib/constants.js` | 协议常量与默认值 |
| `cordis.patch.yml` | bundle 补丁层：改钉 `web.searchProvider`、插入本 entry |
| `probe/` | 阶段 0 的一次性探针（可删） |

---

## 许可

MIT。衍生关系与上游声明见 [NOTICE](./NOTICE)。
