---
name: dsh-web-service
description: 通过 RESTful API 管理 DeepSeek Harness (DSH)：工作区、会话、模型设置、技能、文件与 API Key 管理，支持 SSE、OpenAI 与 Kimi 兼容调用。当需要用 HTTP 接口操作 DSH（三方系统集成、OpenAI 兼容调用、自动化脚本）时使用。
whenToUse: 用户要求通过 HTTP/REST API 调用 DSH、集成三方系统、使用 OpenAI/Kimi 兼容协议对话、管理 API Key、或自动化管理工作区、会话、技能与文件时使用。
---

# DSH Web Service API（dsh-web-service）

本机 DSH 已由插件 `dsh-web-service` 暴露为 Web Service。主要能力通过 REST/SSE 访问，Kimi 兼容层另提供 WebSocket；第三方系统、脚本或 OpenAI 客户端可直接调用。端点以 `src/openapi.ts` 的规范清单及 `src/index.ts` 挂载的实际路由为准；当前规范尚未收录部分已挂载端点，下表补全这些接口。

## 服务地址（按访问路径二选一）

下表是默认部署；原生前缀可由 `pathPrefix` 修改。启用 `standalonePort>0` 时也可用该独立端口访问原生 API 与 Kimi REST/WS。

| 访问路径 | Base URL |
|---|---|
| DSH 本机 / 同内网 | `http://127.0.0.1:3080/api/v1`（DSH 主 webserver 端口，默认 3080） |
| **经 oneNat 隧道** | `http://<隧道host>:<映射public_port>/api/v1` —— 从 oneNat `/api/v1/resources` 里找 `local=127.0.0.1:3080` 的映射，取其 `public_url` 的 host:port 替换即可；tcp 转发可直接承载 HTTP，路径不变 |

- **交互式文档**：`<Base>/docs`
- **Swagger 在线调试**：`<Base>/docs/reference`（资产由 `<Base>/docs/assets/swagger-ui.css` 与 `<Base>/docs/assets/swagger-ui-bundle.js` 自托管，免鉴权）。
- **OpenAPI 规范**：`<Base>/openapi.json`
- **数据面鉴权**：开启鉴权时带 `Authorization: Bearer <key>` 或 `X-API-Key: <key>`，接受有效 managed Key 与遗留 `config.apiKey`；仅创建 Key 不等于开启鉴权。`config.apiKey` 非空强制开启，存储损坏时 fail-closed；关闭鉴权时业务接口匿名可用。
- **公开入口**：文档、文档资产、OpenAPI、API Key 页面 HTML、`/system/updates` 免鉴权；`/system/status` 仍是数据面接口。管理 JSON 接口始终要求独立 Admin Token，见第 7 节。
- **CORS**：默认开启。
- **离线判断**：经隧道访问前先看该映射 `online`；离线则直接报告，不要请求。

快速自检：

```bash
curl -s http://127.0.0.1:3080/api/v1/system/status          # 本机
curl -s http://<隧道host>:<public_port>/api/v1/system/status # 经隧道
```

## Kimi API 兼容层

- 独立 Base URL：`http://127.0.0.1:3080/kimi`；开关 `kimi` 默认 `true`，前缀 `kimiPrefix` 默认 `/kimi`，不受原生 `pathPrefix` 影响。
- 除公开 `GET /healthz` 外，REST 复用数据面 API Key（Bearer / X-API-Key），未开启鉴权时匿名可用；不是管理令牌。WS `/api/v1/ws` 使用 `kimi-code.bearer.<token>` 子协议，主 webserver 缺少 `webServer.registerUpgrade` 时该端口仅 REST 可用；启用 standalonePort 后其独立端口仍支持 WS。
- JSON 信封 `{code,msg,data,request_id,details?}`：成功 `code=0`；业务失败通常 HTTP 200 + 非零 `code`，不能只检查 HTTP 状态。框架层鉴权/参数/体积错误以及下载失败可用真实 HTTP 错误状态。可传 `X-Request-Id`，否则服务端生成 request_id。

### REST 清单（以下路径相对 Kimi Base）

| 方法 | 路径 | 请求 / 响应要点 |
|---|---|---|
| GET | `/healthz` | 公开；`data: {ok:true}` |
| GET | `/api/v1/meta` | 版本、capabilities、server_id；WS 是否可用仍需核对宿主挂载 |
| GET / POST | `/api/v1/workspaces` | 列表 `items[]`；创建 `{root:绝对目录, name?}`，目录须存在 |
| PATCH / DELETE | `/api/v1/workspaces/:id` | 改名 `{name}`（非空，最长 100 字符）/ 删除绑定；使用返回的 Kimi workspace id |
| GET / POST | `/api/v1/workspaces/:id/trust` | 查询 / 设为 trusted；仅进程内状态，不是 DSH 权限闸门 |
| POST | `/api/v1/workspaces/:id/untrust` | 设为 untrusted，同上 |
| POST | `/api/v1/workspaces/:id/add-dir` | 降级 `60002` |
| GET | `/api/v1/sessions` | `page_size`、`before_id/after_id` 游标、`workspace_id`、`busy`、`include_archive`、`archived_only`、`exclude_empty`；返回 `items,has_more` |
| POST | `/api/v1/sessions` | 必须有 `workspace_id` 或 `metadata.cwd`；同时传时 cwd 须等于工作区根；可选 `title,agent_config.model,agent_config.permission_mode`；返回会话 |
| GET | `/api/v1/sessions/:id` | 会话详情 |
| POST | `/api/v1/sessions/:id:action` | `abort/archive/restore/delete/fork/compact/undo/btw`；archive/restore 标记仅进程内保存；fork 可传 `{title}` |
| GET / POST | `/api/v1/sessions/:id/profile` | 读取完整会话 / 更新 `title,agent_config.model,agent_config.permission_mode`；`permission_rules` 当前忽略 |
| GET | `/api/v1/sessions/:id/status` | `busy,model?,thinking_level,permission,context_tokens`；plan/swarm 为 false |
| GET | `/api/v1/sessions/:id/messages` | `page_size,before_id/after_id,role`；返回 `items,has_more` |
| GET | `/api/v1/sessions/:id/messages/:messageId` | 单条消息；缺失 `40403` |
| GET / POST | `/api/v1/sessions/:id/prompts` | 列出 prompts；提交 `{content:[{type:"text",text:"你好"}],prompt_id?,permission_mode?,metadata?}`，立即返回 prompt 元数据（queued/running），结果用 WS 订阅 |
| POST | `/api/v1/sessions/:id/prompts::steer` | **双冒号**批量 `{prompt_ids:[...]}`；返回 `{steered:true,prompt_ids}`，当前只确认，不实际调用 Agent.steer |
| POST | `/api/v1/sessions/:id/prompts:abort` | 中止整个会话；返回 `{aborted,at_seq:0}` |
| POST | `/api/v1/sessions/:id/prompts/:promptId:abort`、`/api/v1/sessions/:id/prompts/:promptId:steer` | 单 prompt 动作；也接受 `/prompts:pid:abort` 与 `/prompts:pid:steer`；abort 实际中止整个会话，steer 仅确认 |
| GET | `/api/v1/sessions/:id/approvals` | 空 `items` 列表 |
| POST | `/api/v1/sessions/:id/approvals/:approvalId` | 降级 `40404` |
| GET | `/api/v1/sessions/:id/questions` | 挂起提问批次 `items[]` |
| POST | `/api/v1/sessions/:id/questions/:questionId` | `{answers:{题目id:答案}}`，例如 `{answers:{q1:{kind:"single",option_id:"o0"}}}`，也支持 multi/option_ids、other/text、multi_with_other/other_text、skipped；成功 `{resolved,resolved_at}` |
| POST | `/api/v1/sessions/:id/questions/:questionId:dismiss` | 拒绝批次，返回 `{dismissed,dismissed_at}`；重复已解决为 `40902` |
| GET | `/api/v1/sessions/:id/snapshot` | `as_of_seq,epoch,session,messages,pending_questions` 等一致快照 |
| GET | `/api/v1/sessions/:id/transcript` | 必传 `agent_id=main`；`page_size` 1–100，`before_turn/after_turn` 互斥；返回转录与 tasks/todos/seq 等投影 |
| GET | `/api/v1/sessions/:id/transcript/ops` | `agent_id=main&since_seq=0`；返回 `batches,latest_seq,complete`，按游标补放 |
| GET | `/api/v1/sessions/:id/goal` | 当前 `data:null` |
| GET | `/api/v1/sessions/:id/warnings` | 当前 `{warnings:[]}` |
| GET / POST | `/api/v1/sessions/:id/children` | GET 空分页列表；POST `60002` |
| POST | `/api/v1/sessions/:id/title/generate` | 降级 `60002`（不是 `/title-generate`） |
| POST | `/api/v1/files` | multipart `file`，可选 `name`；返回 `id,name,media_type,size,created_at`，上传引用仅进程内保存 |
| GET / DELETE | `/api/v1/files/:fileId` | 下载字节流 / 删除上传文件；下载缺失 HTTP 404 |
| GET | `/api/v2/sessions` | `page,page_size`（最大 500）、`meta.archived`、`workspace.id`、`activity.status`、`meta.updated_after/before`、`meta.has_prompt`、`sort,fields,include=git`；返回 `items,total,has_more,next_page_token:null`；使用 page，page_token 当前忽略 |
| POST | `/api/v1/sessions/:id/fs:action` | `list/stat/read/mkdir/search/grep`；body `path` 相对会话 cwd（缺省为空）；限制目录越界与 symlink 逃逸 |
| GET | `/api/v1/sessions/:id/fs/*` | 推荐 `/fs/相对路径:download`；全量 attachment 字节流，暂不支持 Range/etag |

fs 参数：`read` 支持 `offset,limit`；`mkdir` 支持 `create_parents`；`search` 用 `query` 或 `pattern`；`grep` 用 `pattern`（正则）、`case_sensitive,glob`；search/grep 可传 `max_results`。不支持的 fs 动作（如 remove）返回 `40001`。`compact` 为 `40910`，`undo` 为 `40911`，`btw/add-dir/title/generate/children POST` 为 `60002`；fork 新建同工作区会话，不复制历史。

### WS 订阅

连接 `ws://127.0.0.1:3080/kimi/api/v1/ws`，鉴权开启时提供子协议 `kimi-code.bearer.<data-key>`。服务端先发 `server_hello`（`protocol_version=2`）。控制帧格式 `{type,id,payload}`，通过 ack 的 `id/code` 确认结果，例如：

```json
{"type":"subscribe","id":"sub-1","payload":{"session_ids":["实际会话id"]}}
{"type":"subscribe_v2","id":"sub-2","payload":{"session_id":"实际会话id","transcript":{"main":"on"},"transcript_since":{"main":0}}}
```

- `subscribe` 可附 `cursors:{会话id:{seq,epoch}}` 补放原始事件；epoch 改变会发 `resync_required`，需重新取快照。
- `subscribe_v2` 无游标时发 `transcript.reset`，有效 `transcript_since` 时补放 `transcript.ops`；目前只有 main agent（`*` 展开为 main）。
- 还支持 `client_hello`（`subscriptions`）、`unsubscribe`（`session_ids`）、`unsubscribe_v2`（`session_id,agent_ids?`）、`abort`（`session_id`）、`pong`；terminal 控制返回 `60002`。

配置与示例见 [README.zh.md 的 Kimi 章节](../../README.zh.md#kimi-api-兼容层)，真实 REST/WS 用例见 `scripts/smoke-kimi-compat.mjs`。下文响应约定与端点表针对原生 `/api/v1`。

### 公开文档端点（原生 Base）

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/docs` | 交互式请求页 HTML |
| GET | `/docs/reference` | Swagger UI HTML |
| GET | `/openapi.json` | OpenAPI JSON（不使用 ok 信封） |
| GET | `/docs/assets/swagger-ui.css` | 自托管 CSS |
| GET | `/docs/assets/swagger-ui-bundle.js` | 自托管 JS |

## 统一响应约定

普通 JSON 接口返回以下信封（`code` 可选）；SSE、OpenAI 成功响应、HTML、文件下载、技能正文/归档使用各自格式：

```json
{ "ok": true, "data": { ... }, "timestamp": 1788421880661 }
{ "ok": false, "error": "错误信息", "timestamp": ... }
```

HTTP 状态码：`200` 成功、`201` 创建成功、`400` 参数错误、`401` 鉴权失败、`403` 管理面来源/路径保护拒绝、`404` 资源不存在、`409` 冲突、`413` 上传过大、`429` 管理鉴权限流、`500` 内部错误、`503` 依赖服务未挂载。

## 1. 工作区管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/workspaces` | 列出全部工作区 |
| GET | `/workspaces/:id` | 工作区详情 |
| POST | `/workspaces` | 添加工作区，body `{"path": "本地目录", "title": "标题"}`；目录必须已存在 |
| PUT | `/workspaces/:id` | 重命名，body `{"title": "新标题"}` |
| DELETE | `/workspaces/:id` | 删除绑定（保留文件与会话） |
| GET | `/workspaces/:id/sessions` | 该工作区下的会话 |

示例：

```bash
# 添加工作区（目录须已存在，否则先 mkdir）
mkdir -p /tmp/my-project
curl -s -X POST http://127.0.0.1:3080/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{"path": "/tmp/my-project", "title": "我的项目"}'
```

## 2. 会话管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/sessions` | 会话列表；`?search=关键词` 搜索、`?workspaceId=` 按工作区过滤 |
| GET | `/sessions/:id` | 会话详情（状态、模型、所属工作区、cwd、事件数） |
| POST | `/sessions` | 创建会话，body 可选 `{"sessionId", "workspaceId", "cwd", "title", "agentPreset", "provider", "model", "reasoningEffort"}` |
| PUT | `/sessions/:id` | 修改标题和/或模型，body `{"title"?, "provider"?, "model"?, "reasoningEffort"?, "agentPreset"?}` |
| DELETE | `/sessions/:id` | 删除/归档会话并释放 Agent |
| GET | `/sessions/:id/history` | 历史消息分页；`?maxMessages=50`、`?beforeSeq=` |
| GET | `/sessions/:id/stats` | 实时轮/步、LLM/工具耗时、首 token、吞吐、缓存与 token 账本 |
| GET | `/sessions/:id/todos` | `todos[],counts,running,elapsedMs,turnStartedAt,turnEndedAt,updatedAt`；turn/start 清空任务投影 |
| GET | `/sessions/:id/skills` | 会话 cwd 下技能候选；`?search=` 过滤 |
| GET | `/sessions/:id/permission` | 当前权限 `preset` 与 `available` 等 |
| PUT | `/sessions/:id/permission` | `{preset}`，与宿主 `/permission` 同一路径；先查询 available |
| GET | `/sessions/:id/questions` | `{sessionId,count,batches:[{batchId,at,questions}]}`，挂起 ask_user_question 批次 |
| POST | `/sessions/:id/answers` | `{batchId?,answers:[{id,selected:[选项文字],custom?}]}`；默认答最早批次，缺题补空答；无挂起问题 409 |
| POST | `/sessions/:id/cancel` | 中止当前轮次 |
| POST | `/sessions/:id/files` | **上传文件到该会话工作区**：`multipart/form-data`（多文件，字段名任意带 filename 即保存）或原始字节流 + `?filename=`/`X-Filename` 头；同名自动 `-1/-2` 去重永不覆盖；返回 `files[].path` 绝对路径 |
| GET | `/sessions/:id/files` | **列出工作区目录**：`?path=相对子目录` 逐层浏览；返回 `entries[]`（name/type dir\|file\|link/size/mtime/path，目录在前），`entry.path` 可继续用于浏览或下载 |
| GET | `/sessions/:id/files/download` | **下载工作区文件**：`?path=相对路径`；`?inline=1` 内联预览（MIME 按扩展名）；禁止 `../` 越界 |

典型流程：创建 → （上传文件）→ 对话 → 查历史 → 归档。

上传示例：

```bash
# multipart 多文件
curl -X POST http://127.0.0.1:3080/api/v1/sessions/$SID/files \
  -F "files=@./报告.pdf" -F "files=@./data.csv"
# 原始字节流 + 文件名
curl -X POST "http://127.0.0.1:3080/api/v1/sessions/$SID/files?filename=dump.bin" \
  -H "Content-Type: application/octet-stream" --data-binary @./dump.bin
```

上传后把返回的 `path` 写进对话，会话中的 AI 即可用文件工具（fs/shell）直接读取。单次原始请求体上限默认 2GiB（配置 `maxUploadBytes`，含 multipart 开销）；大文件用下面的分片接口，每片仍受该上限约束。

```bash
SID=$(curl -s -X POST http://127.0.0.1:3080/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"title": "测试", "cwd": "/tmp/my-project"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['sessionId'])")
```

`GET /sessions/:id/history` 返回 `messages[]`（`role`: user/assistant，`content`，`seq`，`time`）及 `totalMessages`、`totalEvents`、`hasMore`。

### 分片续传上传

| 方法 | 路径 | 请求 / 响应要点 |
|---|---|---|
| POST | `/sessions/:id/files/resumable` | query `name,size,mimeType?`；返回 `uploadId,name,size,received:0` |
| GET | `/sessions/:id/files/resumable/:uploadId` | 状态 `name,size,received`，用于恢复断点 |
| PUT | `/sessions/:id/files/resumable/:uploadId` | 原始字节流 + `?offset=已接收字节数`；返回新 received；不匹配 409 `OFFSET_MISMATCH` 并给实际 received |
| POST | `/sessions/:id/files/resumable/:uploadId/complete` | size>0 时须完全匹配，否则 409 `INCOMPLETE`；成功去重落盘并返回 `files[].path` |
| DELETE | `/sessions/:id/files/resumable/:uploadId` | 中止并清理临时分片，返回 `aborted:true` |

## 3. 模型管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/models` | 全部模型目录：`provider`、`id`、`name`、`reasoning.efforts`、`routeOnly`、`isDefault` |
| GET | `/models/default` | 当前全局默认模型 `{provider, model, reasoningEffort?}` |
| PUT | `/models/default` | 修改全局默认，body `{"provider", "model", "reasoningEffort"?}`；对新会话生效 |
| GET | `/providers` | 提供商清单，每个含其 `models[]` |
| GET | `/presets` | 可用 Agent Preset；用于会话 agentPreset |

模型条目分两类：
- **目录型**：来自 `modelCatalog.groups`，有名称与 reasoning 档位；
- **路由型**（`routeOnly: true`）：无模型目录但可直接路由。

**选模型前先 `GET /models` 拿合法的 `provider` + `model` 组合**。非法组合会被拒绝：`no adapter registered for provider ...`。

`PUT /models/default` 与设置命名空间 `agent-default-model` 写同一存储，两者互通。

## 4. 流式与同步对话

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sessions/:id/prompt-stream` | **SSE 流式**：body `{"prompt", "mode"?: "normal"\|"steer"}` |
| GET | `/sessions/:id/events` | SSE 订阅该会话全部底层事件 |
| POST | `/sessions/:id/prompt` | 同步阻塞直到本轮完成，返回 `{content, reasoning?, toolCalls[]}` |

### SSE 事件类型（prompt-stream）

| event | data | 含义 |
|---|---|---|
| `connected` | `{sessionId}` | 连接建立 |
| `delta` | `{delta, seq}` | 文本增量 |
| `reasoning` | `{delta, seq}` | 思考过程增量 |
| `tool_call` | `{id?, name, arguments}` | 模型发起工具调用 |
| `tool_result` | `{id?, name, result}` | 工具执行结果 |
| `turn_end` | `{reason}` | 本轮结束 |
| `done` | `[DONE]` | 流终止信号 |
| `error` | `{message}` | 出错 |

```bash
curl -N -X POST http://127.0.0.1:3080/api/v1/sessions/$SID/prompt-stream \
  -H "Content-Type: application/json" \
  -d '{"prompt": "介绍一下你自己"}'
```

`GET /sessions/:id/events` 透传 Harness 原生事件（`turn/start`、`user/message`、`assistant/chunk`（含 `text-delta`/`reasoning-delta` 分片）、`assistant/message`、`tool/call`、`turn/end` 等），按 `seq` 递增。

## 5. OpenAI 兼容接口

`POST /chat/completions`，兼容标准 OpenAI 客户端与 SDK：

```bash
# 非流式
curl -s -X POST http://127.0.0.1:3080/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "PONG测试"}]}'

# 流式（SSE chunks，以 data: [DONE] 结束）
curl -N -X POST http://127.0.0.1:3080/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "你好"}], "stream": true}'
```

- 可传 `sessionId` 延续指定会话；不传则自动创建新会话。
- 可传 `model`，格式 `"provider/model"`（如 `"zai-coding-cn/glm-5.3"`）会为该会话切换模型。
- 非流式响应中带 `sessionId`，可用于后续多轮；流式 chunks 当前不返回该字段，需延续会话时先创建并显式传入 sessionId。

OpenAI Python SDK 用法：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:3080/api/v1", api_key="none")
r = client.chat.completions.create(model="none", messages=[{"role": "user", "content": "你好"}])
print(r.choices[0].message.content)
```

## 6. 设置接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/settings` | 全部设置命名空间（redacted 值 + schema） |
| PATCH | `/settings/:namespace` | 合并写入指定命名空间，body 为 JSON patch |

常用命名空间：`agent-default-model`、`locale`、`ui-theme`、`permission` 等。

## 7. API Key 设置页与管理接口

| 方法 | 路径 | 鉴权 / 响应 |
|---|---|---|
| GET | `/settings/api-keys` | 公开 HTML；`embed=1` 内嵌模式 |

`GET /settings/api-keys` 返回公开 HTML；`?embed=1` 用于 GUI 侧边栏。`/docs` 页头也有入口。页面公开不代表密钥数据公开：以下 `/api-keys*` 全部要求 **Admin Token**，使用 `Authorization: Bearer <admin-token>` 或 `X-Admin-Token`，普通 API Key 不通用。

管理令牌首次启动生成于 `<DSH_HOME>/dsh-web-service/admin-token`（0600；默认 `~/.dsh`），在服务所在机器读取。管理接口默认仅接受 TCP 回环对端，远程需 `adminRemoteAccess:true`；带 Origin 的请求须与 Host 匹配，否则 403。反向代理/隧道下对端可能是本机代理，访问边界需在代理层控制。失败鉴权按 IP 限流（10 次/60 秒），可返回 429。

| 方法 | 路径 | 请求 / 响应要点 |
|---|---|---|
| GET | `/api-keys` | `?includeRevoked=false` 可排除吊销项；默认包含；返回 `keys[]` 脱敏记录、`authEnabled,authEnforcedByConfig,activeKeyCount,storeDegraded` |
| POST | `/api-keys` | `{name?,note?,expiresInDays?,plaintext?}`；201 返回 `{key,plaintext,warning}`；默认随机 dsk_ Key，自定义值为 16–256 可见 ASCII（无空格），有效重复值拒绝 |
| PATCH | `/api-keys/:id` | `{name?,note?,expiresAt?}`；expiresAt 为 epoch 毫秒或 null（清除）；返回脱敏记录 |
| POST | `/api-keys/:id/rotate` | 返回 `{key,plaintext,warning}`；新 id，旧 Key 立即失效，无宽限期 |
| POST | `/api-keys/:id/reveal` | 返回 `{plaintext}`；只有可恢复的 managed Key；历史/已过期/已吊销/密文失效返回 409 `KEY_NOT_RECOVERABLE` |
| POST | `/api-keys/:id/revoke` | 幂等吊销，返回 `id,status,revokedAt,message`；立即失效 |
| DELETE | `/api-keys/:id` | 只删除已吊销 managed 记录；有效或不存在返回 404 |
| GET | `/api-keys/auth` | 鉴权状态、有效数量、legacy/config 强制标记、远程管理与存储降级状态 |
| PUT | `/api-keys/auth` | `{enabled:boolean,confirm?}`；关闭须 `confirm:"disable-auth"`，config.apiKey 非空时不能关闭；无有效 Key 不能开启 |

name 最长 64 字符，note 最长 256 字符；expiresInDays 为 >0 且 ≤3650。配置来源 Key 只读，不可编辑/轮换/吊销/删除。managed Key（随机与自定义）保存 SHA-256 哈希与 Admin Token 派生密钥加密的 sealed（AES-256-GCM），可通过 reveal 复制；自定义 Key 不展示前缀，但同样可经 reveal 取回。管理响应禁缓存。存储损坏 fail-closed，保留 corrupt 文件并尝试 .bak 恢复；写入失败返回 503 `KEYS_STORE_UNAVAILABLE`，不生效。

## 8. 技能管理

所有接口采用数据面鉴权。公共 query `root=user-dsh|user-agents|custom|project|bundled`（默认 user-dsh），project 需 `cwd`；custom/bundled 需服务端相应根配置。

| 方法 | 路径 | 请求 / 响应要点 |
|---|---|---|
| GET | `/skills` | `search` 可过滤；返回技能元数据与根目录信息 |
| POST | `/skills` | JSON `{name,description,whenToUse?,content?,root?}` 或 multipart 技能 .zip/.tgz（file、root、name）；返回落盘信息 |
| GET | `/skills/:name` | 元数据、`content` 正文、`raw` 全文 |
| PUT | `/skills/:name` | `{description?,whenToUse?,content?,modelInvocable?,userInvocable?}`；返回 name/path/size |
| DELETE | `/skills/:name` | 删除目录/扁平技能文件，返回 `deleted:true` |
| GET | `/skills/:name/body` | `text/markdown` 的 SKILL.md 全文 |
| GET | `/skills/:name/archive` | 整个技能目录 .tgz 字节流，含 references 等资源 |

## 9. 宿主文件系统（绝对路径）

全部为数据面接口，与 `/sessions/:id/files` 的 cwd 边界不同：`/fs/*` 操作宿主绝对路径，受服务进程文件系统权限约束。

| 方法 | 路径 | 请求 / 响应要点 |
|---|---|---|
| GET | `/fs/list` | `?path=绝对目录`（缺省 home）；默认只列目录，`all=1/true` 或 `files=1` 包含文件；返回 path/home/parent/entries/truncated/maxEntries |
| GET | `/fs/download` | 必传 `path` 绝对文件；`inline=1/true` 预览；返回字节流 |
| POST | `/fs/mkdir` | `{path:父目录绝对路径,name:单级目录名}`；返回 path/name；同名 409 |
| DELETE | `/fs/remove` | `?path=绝对路径`，递归删除文件/目录；禁止 `/` 与用户 home 根；返回 removed:true |
| POST | `/fs/upload` | `?path=目标绝对目录`，multipart 多文件或 raw + filename/X-Filename；同名去重，返回 count/files[] |

## 10. 系统状态与更新检查

| 方法 | 路径 | 鉴权 / 响应要点 |
|---|---|---|
| GET | `/system/status` | 数据面；版本、端口/prefix、providers、workspacesCount、authEnabled、apiKeyCount、keysStoreDegraded、uptime |
| GET | `/system/updates` | **公开**；`{current,latest,updateAvailable,releaseUrl,checkedAt,error?}` |

更新源唯一为 [Wuqiyang312/deepseek-server-api 的 GitHub Releases](https://github.com/Wuqiyang312/deepseek-server-api/releases)，调用 `https://api.github.com/repos/Wuqiyang312/deepseek-server-api/releases/latest`，与项目主页/问题反馈同源。成功缓存 10 分钟，失败缓存 60 秒，请求超时 5 秒；网络失败仍 HTTP 200 + ok:true，但 `latest/updateAvailable=null` 并带 error，不表示服务故障。仓库暂无 Release 时 updateAvailable=false、latest=null，并带说明。接口仅检查，不安装；`/docs` 与 API Key 页头提供「检查更新」按钮。

```bash
curl -s http://127.0.0.1:3080/api/v1/system/updates
```

## 排错速查

| 现象 | 处理 |
|---|---|
| 连接拒绝 | DSH 未启动或端口非 3080；先查 `system/status` |
| 经隧道超时/拒绝 | 隧道离线：查 oneNat resources 里该映射 `online`，离线报告用户，不要重试 |
| 401 | 数据面检查 auth 开关、Key 过期/吊销与 legacy 配置；管理面 ADMIN_UNAUTHORIZED 需 Admin Token，不能用普通 Key |
| 管理面 403/429 | 检查 TCP 对端是否回环、adminRemoteAccess、Origin/Host；限流后等窗口恢复，不循环试令牌 |
| reveal 返回 409 | 历史/已过期/已吊销 Key 或密文失效，不能恢复；需替换或轮换 |
| Kimi HTTP 200 却失败 | 检查信封 code/msg/details；非零 code 为业务失败 |
| 模型选择报 no adapter | `provider/model` 非法；先 `GET /models` 校验 |
| 新会话模型不对 | 全局默认被改过；查 `GET /models/default`，或创建时显式传 `provider/model` |
| 流式空回复 | 先确认轮次是否仍在运行及有无挂起 questions；会话刚创建需 Agent 就绪，空闲时可用 `POST /sessions/:id/prompt` 同步等待，或先 `GET /sessions/:id/events` 确认事件在流动 |
| 首帧迟迟不来 | 模型排队/长思考，首个增量实测可达 5~8 分钟：先 `GET /sessions/:id` 看状态再决定，勿急于判死重发 |
| 连续 401/403 | API key 失效或已轮换：**停止循环重试**，刷新 key 配置后再试一次，仍失败如实报告 |
| prompt 被拒 `agent-busy` | 会话正在跑；先 `POST /sessions/:id/cancel` 或改 `mode: "steer"` 追加 |

## 调用策略

- 一切以**实测 curl**为准；不要凭记忆猜测端点或字段。
- 批量操作前先查列表拿到真实 id（id 格式按接口返回值使用；session id 通常为 `session-<UUID>`，Kimi workspace id 是别名）。
- 长任务用 `prompt-stream` 或 `events` 监听，避免同步阻塞超时。
- 三方集成优先走 `/chat/completions`（标准协议、免协调会话生命周期）。

## 自动化调用守则（定时任务 / 子智能体 / 脚本必读）

- **禁止交互等待**：无人值守上下文不得调用 `ask_user_question` 等等待人工答复的工具。参数不全（如收件群/收件人无法解析）时取保守默认执行，并在产出中显式说明假设；有人值守的会话才允许提问。
- **首帧慢 ≠ 失败**：大 prompt + 模型排队时首个增量可达 5~8 分钟，SSE 静默先查 `GET /sessions/:id` 会话状态；10 分钟内不要判定失败重发——重复 prompt 会把整轮任务重跑一遍。
- **401 即停**：同一接口连续 2 次 401/403 即停止重试；先刷新 API key / 凭证来源再重试一次，仍失败如实报告，不要拿旧凭证反复敲接口。
- **禁止自派发**：任务指令里提到的 `@某智能体` /「远程 DSH」若经核对（baseUrl、hostname 一致）就是当前节点或当前会话，直接本地执行；不要再经本 API 新建会话把任务派回自己，白绕一跳且易嵌套死循环。
