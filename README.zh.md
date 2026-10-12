# dsh-webapi (dsh-web-service)

[English](README.md) | **中文**

> 第一次用？先看图文版 [使用教程](docs/TUTORIAL.zh.md)。

把 DeepSeek Harness 通过 HTTP 开放出来：DSH 里的工作区、会话、模型、设置、技能与文件直接变成
REST 接口与 SSE 流，再加一个 OpenAI 兼容的 `/chat/completions`，现成的 OpenAI 客户端不用改就能接到 DSH。

典型用法：给 DSH 做一个自托管控制台、桌面或移动端客户端、驱动 Agent 的 CI/自动化流程、
把 DSH 当成工具调用的其它 Agent，或在 DSH 前面再包一层自己的 API 网关。

- **零新增依赖**：插件只 `inject` `webServer` 与 `tools`，路由挂在 DSH 宿主的 webserver 上（也可选独立端口）。
- **REST、SSE 与 Kimi WS 接口**，内置 OpenAPI 3.0 规范、在线调试页与 API Key 设置页。
- **自带中文 SKILL**：`skills/dsh-web-service/SKILL.md` 教会 DSH 里的 Agent 调用本 API（流式、中止、
  回答挂起问题、上传文件等）。

## 安装

兼容 DSH `0.1.0`–`0.2.x`（peer 范围见 `package.json`；已在 `0.1.7-rc.2` 上运行验证，并在 `0.2.0-rc.2` 上通过类型检查与运行时装配验证）。

**方式一：预构建 tarball（推荐，免构建、免 `allowBuilds` 授权）**

本插件 `inject` 宿主的 `webServer`，该服务由随附 web 模板的组合包（base + web-app）提供。
自定义 profile 名（如 `api-server`）需先从该模板初始化一次，再安装：

```bash
# 1) 仅首次：从随附 web 模板初始化 api-server profile（dump 模式只初始化、不启动应用）
dsh --profile api-server --from-default-profile web --dump-config > /dev/null
# 2) 把本插件装进该 profile
dsh plugin --profile api-server add \
  https://github.com/Wuqiyang312/deepseek-server-api/releases/latest/download/dsh-web-service.tgz
# 3) 启动（若 DSH 已在运行则重启）
dsh --profile api-server
```

`--from-default-profile` 在目标已存在时会被拒绝，所以第 1 步只需执行一次。用专属名而不是随附的
`web`，可与 DSH Web GUI 的 profile 互不干扰。

`dsh plugin` 会把该包写进 profile 的 `package.json`（依赖 + `dsh.profile.bundles`）；
带 HMR 的 profile 会立即装配，否则重启 DSH 生效。探活：

```bash
curl -s http://127.0.0.1:3080/api/v1/system/status   # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/v1/docs # 200
```

> **升级提示。** 资产名不带版本号，`latest/download/dsh-web-service.tgz` 对**全新安装**永远指向最新构建；
> 但包管理器可能复用该 URL 的旧解析结果。要把已有安装切到确定版本，用带版本号的资产：
> `dsh plugin --profile api-server add https://github.com/Wuqiyang312/deepseek-server-api/releases/download/v0.1.11/dsh-web-service-0.1.11.tgz`

**方式二：直接从 git 仓库安装**（插件管理器的「GitHub 仓库地址」安装方式）

```bash
dsh plugin --profile web add github:Wuqiyang312/deepseek-server-api
```

`lib/` 已入库，所以从 git 装的包可直接运行。`lib/` 与 `src/` 保持同步——改动 `src/` 后，
请在同一次改动里重新构建并提交 `lib/`。

**方式三：从源码构建**（需要一份 DSH 源码 checkout）

```bash
git clone https://github.com/Wuqiyang312/deepseek-server-api && cd deepseek-server-api
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh     # src/ → lib/
dsh plugin --profile web add "$PWD"
```

`scripts/build.sh` 会从 checkout 软链 `cordis` / `schemastery` / `@deepseek-ai/*` 等 peer，无需 `npm install`。

## 配置

全部可选，装好后写在 profile patch 的插件行 `config` 里（默认值见 `src/index.ts`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `pathPrefix` | `/api/v1` | 路由前缀 |
| `apiKey` | `''` | 遗留 Key；非空强制鉴权，接受它或有效 managed Key |
| `standalonePort` | `0` | `>0` 时额外独立监听端口；`0` 表示只挂主 webserver |
| `cors` | `true` | 是否允许跨域 |
| `defaultCwd` | `''` | 默认工作目录，留空取 `process.cwd()` |
| `maxUploadBytes` | `2 GiB` | 上传大小上限，大文件建议走分片接口 |
| `adminRemoteAccess` | `false` | 是否允许**非回环**地址访问 API Key 管理接口；默认仅本机可管理密钥 |
| `kimi` | `true` | 启用 Kimi REST / WS 兼容层 |
| `kimiPrefix` | `/kimi` | Kimi 独立路由前缀 |

> `apiKey` 只是「遗留单 Key」，向后兼容用。日常管理请到设置页生成/吊销多条 Key，详见
> [API Key 管理](#api-key-管理设置页)。

## API Key 管理（设置页）

打开 **`GET /api/v1/settings/api-keys`** 即可在一个页面里管理三方调用鉴权的密钥：
查看（脱敏）、新建、轮换、吊销、开启/关闭鉴权。`/docs` 页头部也有「管理 API Key」入口。

**三个入口**

| 入口 | 说明 |
|---|---|
| DSH Web GUI 侧边栏「API Key 管理」 | 插件自带浏览器半边（client half），装好并重启 DSH 后出现在侧边栏，内嵌本页 |
| `GET /api/v1/settings/api-keys` | 独立页面，可直接收藏 |
| `/docs` 页头「管理 API Key」按钮 | 从 API 文档一键跳转 |

页面按**管理令牌闸门**设计：密钥管理与普通 API 调用是两套凭证。首次打开会要求输入管理令牌，
页面会直接给出取令牌的命令（在运行 DSH 的机器上执行）：
`cat <DSH 配置根>/dsh-web-service/admin-token`，粘贴一次后保存在浏览器 localStorage。
未通过闸门时，页头的「新建 API Key」等管理按钮一律收起——不会出现「点了按钮才报 401」的死胡同。

### 页面主题与离线可用

`/docs`、`/docs/reference`、`/settings/api-keys` 三个页面统一使用 **HARNESS 设计令牌**
（`--dsw-alias-*`，取值镜像 `packages/client/ui-theme/src/styles/design-platform.css`），
因此配色、圆角、字号与 DSH Web GUI 一致，并同时支持浅色 / 深色：

- **内嵌在 GUI 侧边栏时**（同源 iframe）直接读取父页面的令牌计算值并实时跟随其明暗切换，
  用户自定义主题同样生效；
- **独立打开时**按系统 `prefers-color-scheme`，也可用 `?theme=light` / `?theme=dark` 强制。

Swagger UI 资产随包自托管在 `vendor/swagger-ui/`，由 `/api/v1/docs/assets/*` 提供，
**不依赖任何公共 CDN**，内网或离线环境同样可以打开 `/docs/reference`。

内嵌在 GUI 侧边栏时，页内的「SWAGGER / 查看 OpenAPI JSON / 交互式文档」等按钮会在**面板内**跳转
（目标页给出「← 返回」按钮）。原因：DSH Desktop 主窗口显式拒绝一切新窗口
（`webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`），`target="_blank"` 在应用内是
**静默失败**；外部链接（GitHub / 问题反馈）仍会尝试新窗口，被拒时提示复制链接。

新建时有**两种 Key 值来源**，对应 `POST /api-keys` 的 `plaintext` 字段：

| 方式 | 行为 |
|---|---|
| 随机生成（默认） | 服务端生成 `dsk_` + 32 字节 CSPRNG（256 位熵） |
| **使用自定义 Key** | 粘贴你已有的 Key（16–256 个可见 ASCII 字符），用于接入既有客户端或迁移 |

> 自定义 Key 的强度由你负责，因此它**连前缀都不展示**（列表里标记「自定义」）——否则一个
> `my-secret-api-key-xxx` 露出前 12 位就泄露了大半价值。服务端保存哈希与管理令牌加密的封装，仍可通过管理接口复制。
> 同值的**有效**记录会被拒绝（400）；已吊销 / 已过期的值可以重新登记。

**两套凭证，互不通用**

| 用途 | 凭证 | 头部写法 |
|---|---|---|
| 调用业务接口（数据面） | API Key | `Authorization: Bearer <key>` 或 `X-API-Key: <key>` |
| 管理密钥（管理面） | Admin Token | `Authorization: Bearer <admin-token>` 或 `X-Admin-Token: <admin-token>` |

这样持有 API Key 的三方客户端无法给自己增发密钥。Admin Token 由插件**首次启动时自动生成**，
存放在 DSH 配置根下的 `dsh-web-service/admin-token`（权限 0600）：

```bash
cat "${DSH_HOME:-$HOME/.dsh}/dsh-web-service/admin-token"
```

**安全约定**

- managed Key（随机与自定义）落盘保存两项：`sha256(明文)`（鉴权用）和一份**可逆密文** `sealed`（列表页「复制」用）。
  `sealed` 是用**管理令牌经 HKDF 派生的密钥**做的 AES-256-GCM；因此 `api-keys.json` 单独泄露
  （备份、截图、贴到 issue）还原不出 Key，还需要同目录下 0600 的 `admin-token`。
- 列表页可恢复且有效的 managed Key 可「复制」，**明文通过管理令牌鉴权的接口现取现用**，只写进剪贴板，
  不进 DOM、不写 localStorage、不打日志。
- 加密存储上线**之前**创建的 Key 只有哈希，明文不可恢复 —— 点「复制」会直接引导到「轮换」生成新 Key；
  管理令牌被删除重建后，旧密文的解密封装也随之失效，同样表现为「不可复制，请轮换」（不会静默给错值）。
- 管理接口默认**只允许本机（回环）访问**；远程管理需显式设置 `adminRemoteAccess: true`。
  带 Origin 的浏览器请求会核对 Origin.host 与 Host（防跨源管理），跨源返回 `403 FORBIDDEN_ORIGIN`。
- 吊销立即生效且不可恢复；轮换会让旧 Key 立即失效——更稳妥的做法是先「新建」替代 Key 分发，
  确认切换完成后再吊销旧的。
- 插件配置里存在 `apiKey` 时鉴权被**强制开启**，页面上无法关闭（防止误放松保护）；
  没有任何有效 Key 时也不允许开启鉴权，避免把自己锁在外面。
- 密钥存储文件损坏时按 fail-closed 处理：不放松鉴权，`/system/status` 会报 `keysStoreDegraded`。
  损坏文件会改名为 `api-keys.json.corrupt-<时间戳>` 保留取证，并自动从 `api-keys.json.bak`
  （每次成功写入后更新的「最后已知良好状态」）恢复，不会静默丢弃既有密钥记录。
- 管理接口的回环判定看的是 TCP 对端地址。若 DSH 前面挂了反向代理 / 隧道（例如把端口转发到公网），
  插件会把代理端当成对端地址，此时回环护栏形同虚设——必须自行在网络层收口，或保持
  `adminRemoteAccess: false` 并只在本机做管理操作。
- 数据面（业务接口）的鉴权是 Bearer / API Key 校验，**不含**同源校验：它本来就面向跨域三方客户端，
  因此浏览器页面携带有效 Key 的跨源请求属于预期能力；跨域放行范围由 `cors` 控制。
- 管理令牌会保存在浏览器 `localStorage`，公用电脑用完请在页面上「清除本机管理令牌」。

数据文件位于 `<DSH_HOME>/dsh-web-service/api-keys.json`（0600）。

## 功能特性

1. **工作区管理 (Workspaces)**：添加、删除、修改、查询工作区及其关联会话。
2. **会话管理 (Sessions)**：添加、删除/归档、修改标题/模型、列表查询及消息历史记录分页。
3. **设置与模型管理 (Models & Settings)**：查询可用模型列表、提供方列表、获取与修改系统全局默认模型配置、读取设置命名空间、列出 Agent Preset。
4. **会话流式交互 (Streaming)**：
   - `POST /sessions/:id/prompt-stream`：基于 Server-Sent Events (SSE) 实时推送 `delta`、`reasoning`、`tool_call`、`tool_result` 与 `turn_end`。
   - `GET /sessions/:id/events`：会话底层事件总线实时广播监听通道。
5. **OpenAI 兼容协议**：
   - `POST /chat/completions`：支持标准 OpenAI 客户端调用（兼容 `stream: true/false`）。
6. **交互式 Web UI 文档 & OpenAPI 规范**：
   - 内置交互式 API 测试面板：`GET /api/v1/docs`
   - OpenAPI 3.0 规范：`GET /api/v1/openapi.json`
7. **交互式会话**：读取挂起的 `ask_user_question` 问题并经 REST 作答、中止正在跑的轮次、
   上传/列出/下载工作区文件（含分片续传上传）。
8. **API Key 设置页与密钥管理**：`GET /api/v1/settings/api-keys` 一页管理三方调用密钥——
   多 Key 并存可命名、脱敏展示、新建/轮换/吊销、列表一键复制、开启关闭鉴权；落盘存哈希 + 管理令牌加密的密文。

## Kimi API 兼容层

挂载在独立前缀（默认 `/kimi`，配置项 `kimiPrefix`）下的 Kimi 本地服务（kap-server）API 兼容层。真实 REST 调用示例（鉴权关闭时省略 Authorization）：

```bash
curl -s http://127.0.0.1:3080/kimi/api/v1/sessions \
  -H 'Authorization: Bearer <data key>'
curl -s -X POST http://127.0.0.1:3080/kimi/api/v1/sessions \
  -H 'Authorization: Bearer <data key>' -H 'Content-Type: application/json' \
  -d '{"metadata":{"cwd":"/tmp/my-project"},"title":"Kimi compat"}'
```

- 开关：`kimi`（默认 `true`）；前缀：`kimiPrefix`（默认 `/kimi`），不受原生 pathPrefix 影响。
- 鉴权：复用数据面 API Key；关闭鉴权时匿名可用，`GET /kimi/healthz` 始终公开。WS 使用 `kimi-code.bearer.<token>` 子协议。
- REST：`/kimi/api/v1/**` 与 `/kimi/api/v2/sessions`；JSON 信封 `{code,msg,data,request_id,details?}`，业务失败通常 HTTP 200 + 非零 code；框架错误及下载失败可返回真实 HTTP 错误状态。
- WS：`/kimi/api/v1/ws`，server_hello protocol_version=2；subscribe 用 session_ids/cursors，subscribe_v2 用 session_id/transcript/transcript_since，支持 transcript.reset / transcript.ops 与游标重放。
- prompt：`POST /kimi/api/v1/sessions/:id/prompts` 提交 content blocks；`/prompts::steer`（双冒号，prompt_ids）及单 prompt steer 当前只确认，不真正改向；abort 会中止整个会话。
- fs 动作：`POST /kimi/api/v1/sessions/:id/fs:list` 等，支持 list/stat/read/mkdir/search/grep；下载 `GET /kimi/api/v1/sessions/:id/fs/relative-path:download`，限制会话目录越界，暂不支持 Range/etag。
- 降级：approvals 空列表/40404；fork 新建同工作区会话、不复制历史；compact 40910；undo 40911；btw、add-dir、children POST、`/title/generate` 60002。archive/restore 与 trust 标记仅进程内保存。
- 主 webserver 需支持 webServer.registerUpgrade 才启用该端口 WS，缺失时仅 REST（启动警告）；可选 standalonePort 的独立监听仍支持 WS。

完整 REST 清单、WS 帧与用法见 [SKILL.md](skills/dsh-web-service/SKILL.md#kimi-api-兼容层)，可运行用例见 `scripts/smoke-kimi-compat.mjs`。

## API 路由汇总

默认基础前缀：`/api/v1`

普通接口走数据面 API Key；文档/资产、设置页 HTML、updates 公开，`/api-keys*` JSON 接口需 Admin Token。OpenAPI 尚未收录部分已挂载路由，以下清单按实际挂载补全。`/fs/*` 操作宿主绝对路径，`/sessions/:id/files` 限于会话 cwd。

| 模块 | 方法 | 路径 | 说明 |
|---|---|---|---|
| **System** | `GET` | `/system/status` | 系统状态、在线模型及端口信息 |
| | `GET` | `/system/updates` | 公开检查 GitHub Releases 更新 |
| **Workspaces** | `GET` | `/workspaces` | 查询工作区列表 |
| | `POST` | `/workspaces` | 创建/添加工作区 |
| | `GET` | `/workspaces/:id` | 获取工作区详情 |
| | `PUT` | `/workspaces/:id` | 修改工作区标题 |
| | `DELETE` | `/workspaces/:id` | 删除工作区绑定 |
| | `GET` | `/workspaces/:id/sessions` | 查询工作区下的会话 |
| **Sessions** | `GET` | `/sessions` | 查询会话列表 (支持搜索和工作区过滤) |
| | `POST` | `/sessions` | 创建新会话 |
| | `GET` | `/sessions/:id` | 查询单个会话详情与状态 |
| | `PUT` | `/sessions/:id` | 修改会话 (标题/模型) |
| | `DELETE` | `/sessions/:id` | 删除/归档会话 |
| | `GET` | `/sessions/:id/history` | 分页查询会话历史消息 |
| | `GET` | `/sessions/:id/stats` | 会话实时统计：轮/步、LLM 与工具调用耗时、首 token 均值、解码吞吐、缓存命中、token 账本（对齐 harness session-stats 投影语义） |
| | `GET` | `/sessions/:id/todos` | 会话任务清单 + 运行时长：`todos[{content,status}]`（`todo_write` 整表投影，`turn/start` 清空）、`counts{completed,inProgress,pending}`、`running`/`elapsedMs`（当前或最后一轮 turn 墙钟）、`turnStartedAt`/`turnEndedAt`/`updatedAt`（供三方控制台渲染「任务」面板，≥0.1.8） |
| | `GET` | `/sessions/:id/skills` | 会话作用域技能目录（按会话 cwd 解析技能根，支持 `?search=` 过滤；供输入框 "/" 技能候选，对齐 harness skills/list） |
| | `GET` | `/sessions/:id/questions` | 查询会话当前挂起的 ask_user_question 问题批次（REST 集成的宿主侧答复桥，≥0.1.7；含 connection 层抢答绕过与 ALS 会话归属） |
| | `POST` | `/sessions/:id/answers` | 提交挂起问题的答复（`answers: [{id, selected, custom?}]`），resolve 后工具以普通 tool/result 返回、会话继续 |
| | `POST` | `/sessions/:id/cancel` | 中止会话轮次 |
| | `POST` | `/sessions/:id/files` | 上传文件到会话工作区 (multipart 多文件 或 raw+?filename=)；同名自动 -1/-2 去重，AI 可用文件工具直接读取 |
| | `GET` | `/sessions/:id/files` | 列出会话工作区目录（?path= 浏览相对子目录，目录优先排序） |
| | `GET` | `/sessions/:id/files/download` | 下载工作区文件（?path= 相对路径；?inline=1 浏览器内联预览） |
| | `GET` | `/sessions/:id/permission` | 当前权限 preset 与可选项 |
| | `PUT` | `/sessions/:id/permission` | 以 `{preset}` 切换权限 |
| **Files** | `POST` | `/sessions/:id/files/resumable` | 以 `?name=&size=&mimeType=` 初始化，返回 uploadId |
| | `GET` | `/sessions/:id/files/resumable/:uploadId` | 查询 size 与 received 字节数 |
| | `PUT` | `/sessions/:id/files/resumable/:uploadId` | 原始分片 + `?offset=`；断点不匹配返回 409 |
| | `POST` | `/sessions/:id/files/resumable/:uploadId/complete` | 完成上传，核对大小，返回 files[].path |
| | `DELETE` | `/sessions/:id/files/resumable/:uploadId` | 中止并清理暂存分片 |
| **Streaming** | `POST` | `/sessions/:id/prompt-stream` | SSE 流式发送提示词并接收生成 |
| | `GET` | `/sessions/:id/events` | SSE 会话全局事件监听订阅 |
| | `POST` | `/sessions/:id/prompt` | 同步等待对话结果 |
| **OpenAI** | `POST` | `/chat/completions` | 兼容 OpenAI Chat 协议 (流式/非流式) |
| **Models** | `GET` | `/models` | 查询可用模型清单与默认模型 |
| | `GET` | `/models/default` | 获取全局默认模型 |
| | `PUT` | `/models/default` | 更新全局默认模型 |
| | `GET` | `/providers` | 查询注册的 LLM 提供商 |
| | `GET` | `/presets` | 查询可用 Agent Preset 清单 |
| **Settings** | `GET` | `/settings` | 获取系统设置配置命名空间 |
| | `PATCH` | `/settings/:namespace` | 更新指定命名空间配置 |
| **Skills** | `GET` | `/skills` | 技能列表；query `root,cwd,search` |
| | `POST` | `/skills` | JSON 创建或 multipart 上传 .zip/.tgz |
| | `GET` | `/skills/:name` | 元数据、正文与全文 |
| | `PUT` | `/skills/:name` | 更新元数据 / 正文 / 调用标记 |
| | `DELETE` | `/skills/:name` | 删除技能 |
| | `GET` | `/skills/:name/body` | 以 text/markdown 下载 SKILL.md |
| | `GET` | `/skills/:name/archive` | 下载完整技能目录 .tgz |
| **FS** | `GET` | `/fs/list` | 绝对目录（缺省 home）；`all=1` 包含文件 |
| | `GET` | `/fs/download` | 绝对文件 `?path=`；可选 `inline=1` |
| | `POST` | `/fs/mkdir` | 以 `{path:父目录,name}` 新建目录 |
| | `DELETE` | `/fs/remove` | 绝对 `?path=` 递归删除；保护根目录/home 根 |
| | `POST` | `/fs/upload` | 目标绝对目录 `?path=`；multipart 或 raw 上传 |
| **API Keys** | `GET` | `/settings/api-keys` | **API Key 设置页**（HTML，公开；数据接口需 Admin Token） |
| | `GET` | `/api-keys` | 列出 API Key（脱敏，不含明文/哈希） |
| | `POST` | `/api-keys` | 新建 API Key（返回明文，之后可随时复制） |
| | `PATCH` | `/api-keys/:id` | 修改名称 / 备注 / 过期时间 |
| | `POST` | `/api-keys/:id/rotate` | 轮换（旧 Key 立即失效，新 Key 可随时复制） |
| | `POST` | `/api-keys/:id/reveal` | 取回明文用于复制（需管理令牌；历史 / 过期 / 吊销 / 密文失效 Key 返回 409） |
| | `POST` | `/api-keys/:id/revoke` | 吊销（幂等，不可恢复） |
| | `DELETE` | `/api-keys/:id` | 删除记录（仅限已吊销的 Key） |
| | `GET` | `/api-keys/auth` | 查询鉴权状态 |
| | `PUT` | `/api-keys/auth` | 开启 / 关闭鉴权（关闭需 `confirm: "disable-auth"`） |
| **Docs** | `GET` | `/docs` | 内置交互式 API 测试页面 |
| | `GET` | `/docs/reference` | 在线接口文档与调试（Swagger UI，规范内接口 Try it out） |
| | `GET` | `/openapi.json` | OpenAPI 3.0 接口定义 |
| | `GET` | `/docs/assets/swagger-ui.css` | 自托管 Swagger 样式（公开） |
| | `GET` | `/docs/assets/swagger-ui-bundle.js` | 自托管 Swagger 脚本（公开） |

## 更新检查

`/docs` 与 API Key 设置页页头均有「检查更新」按钮，也可直接调用公开接口：

```bash
curl -s http://127.0.0.1:3080/api/v1/system/updates
```

返回 `data:{current,latest,updateAvailable,releaseUrl,checkedAt,error?}`。唯一更新源为 [Wuqiyang312/deepseek-server-api 的 GitHub Releases](https://github.com/Wuqiyang312/deepseek-server-api/releases)（API：`https://api.github.com/repos/Wuqiyang312/deepseek-server-api/releases/latest`），与主页/问题反馈同源。成功缓存 10 分钟，失败缓存 60 秒，超时 5 秒；失败仍 HTTP 200 + ok:true，但 latest/updateAvailable 为 null 并附 error，不影响服务。暂无 Release 时 updateAvailable=false、latest=null，并附说明。此接口只检查，不自动安装；升级方式见安装章节。

## 开发与构建

```bash
# 构建插件
bash scripts/build.sh

# 运行时热注入 (需 dsh-super-injector)
dev_inject_plugin {"dir": "/path/to/dsh-web-service"}

# 热重载
dev_reload_package {"packageName": "dsh-web-service"}
```

## SKILL：让 AI 智能体学会调用本 API

本仓库自带一份 DSH 原生 SKILL（`skills/dsh-web-service/SKILL.md`），安装后 AI 智能体会自动发现并掌握全部接口的用法（触发词：HTTP 操作 DSH、三方集成、OpenAI 兼容调用等），会话内也可用 `/dsh-web-service` 直接调用。

### 一键在线安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/Wuqiyang312/deepseek-server-api/main/scripts/install-skill.sh | bash
```

安装到用户级 skill 目录 `~/.dsh/skills/dsh-web-service/`，DSH 的 skill-filesystem 提供方会热发现（无需重启），下一个会话即可用。

### 可选参数

```bash
# 安装到指定目录（项目级 .dsh/skills 或 .agents/skills）
curl -fsSL https://raw.githubusercontent.com/Wuqiyang312/deepseek-server-api/main/scripts/install-skill.sh | bash -s -- --dir /path/to/project/.dsh/skills

# 指定分支 / 仓库
curl -fsSL https://raw.githubusercontent.com/Wuqiyang312/deepseek-server-api/main/scripts/install-skill.sh | bash -s -- --branch dev
curl -fsSL https://raw.githubusercontent.com/Wuqiyang312/deepseek-server-api/main/scripts/install-skill.sh | bash -s -- --repo other/deepseek-server-api

# 卸载
curl -fsSL https://raw.githubusercontent.com/Wuqiyang312/deepseek-server-api/main/scripts/install-skill.sh | bash -s -- uninstall
# 或本地：bash install-skill.sh uninstall
```

脚本行为：下载 SKILL.md → 校验 frontmatter 合法性 → 安装到目标目录 → 探测本机 3080/3000 端口的 DSH Web Service 是否在线并提示。幂等可重复执行。

### 本地安装（仓库内）

```bash
bash scripts/install-skill.sh
```

## License

BSD-3-Clause
