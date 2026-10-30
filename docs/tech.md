# 技术方案

> 技术选型、数据模型、接口契约的权威标准。版本升级需先改本文档再动 package.json。
> 最后更新：2026-10-26

## 1. 技术选型（版本固定）

| 包 | 版本 | 说明 |
|---|---|---|
| electron | 44.1.1 | 内置 Node ≥22：全局 fetch、randomUUID、protocol.handle，无需 axios/eventsource |
| electron-vite | 5.0.0 | 单配置管理 main/preload/renderer，React HMR |
| vite | 7.3.6 | 不可升 vite 8（与 electron-vite 5 不兼容） |
| @vitejs/plugin-react | 5.2.0 | 6.x 需 vite 8，固定 5.x |
| react / react-dom | 19.2.8 | UI 框架 |
| zustand | 5.0.15 | 状态管理：导航 + 数据缓存 + 流式状态 |
| react-markdown | 10.1.0 | AI 回复的 Markdown → React 元素。**不用 marked**：marked 产物是 HTML 字符串，要塞进页面就得 `dangerouslySetInnerHTML` 再配一个消毒库；react-markdown 产物是元素，全程不碰 innerHTML |
| remark-gfm | 4.0.1 | 表格 / 删除线 / 任务列表 / 裸网址识别 |
| rehype-highlight | 7.0.2 | 代码块语法高亮（lowlight → highlight.js 的 37 种常用语言；`highlight.js` 那 5.5MB 是全部 190 种语言的源码包，实际只打包用到的） |
| electron-builder | 26.15.3 | 打包 NSIS 安装包 + 便携版 |
| typescript | 5.9.3 | 不用 7.0（全新原生编译器，工具链风险） |
| @types/react / @types/node | 19.2.18 / 26.4.1 | 仅类型 |
| @types/react-dom | ^19.0.0（实际装上 19.2.7） | 仅类型（`main.tsx` 用 `react-dom/client`）。**全项目唯一没锁精确版本的一个**——其余 14 个都是精确版本；实际装的版本由 package-lock.json 钉住，`npm ci` 仍可复现。要改成精确锁，先改本行再动 package.json |

**关键决策**：
- **导航用 zustand 状态机，不用 react-router**：底部 Tab + 返回栈，桌面应用无需 URL
- **所有依赖放 devDependencies**：electron-vite 全量打包进 out/，安装包不含 node_modules
- package.json 不设 `"type":"module"`：main/preload 走 CommonJS 成熟路径
- **零原生模块**（无 better-sqlite3 等），持久化用主进程 JSON 文件
- **渲染层用成熟库、请求侧继续手写**：Markdown 的边界情况（嵌套列表、表格、代码围栏、行内代码与转义）太多，不值得手写，用 react-markdown 这条成熟链路；而请求侧的 SSE 解析只有几十行、格式完全固定，继续手写（见 §7）
- **卡片只留「一段人设 + 后置词 + 世界书」，不把外部格式的三区结构搬进界面**：面对的是不懂技术的新手，多一个分区就多一层困惑。外部卡的三区（前置词 / 提示词 / 后置词）在**导入时折叠**——前置词与提示词正文合成「角色设定」，后置词单独留字段（它必须待在消息末尾才有效）。详见 §3「卡片的外部格式与导入映射」
- 开发机需 Node ≥ 22.12

## 2. 目录结构

```
src/
├─ shared/types.ts          # 全部接口/IPC 频道常量/ChatEvent 联合类型/默认值（唯一真源）
├─ shared/memory.ts         # 记忆纯函数：归一、窗口、容量工具、标记解析（main/renderer 共用）
├─ main/
│  ├─ index.ts              # 窗口(1100×750)、安全开关、app-media:// 协议、退出时保存半截回复
│  ├─ store.ts              # JSON 持久化层（原子写、每文件写队列、缓存、首次运行示例卡）
│  ├─ providers.ts          # 供应商配置的读写与迁移（providers.json）
│  ├─ worldbook.ts          # 世界书注入算法 + 消息组装（含记忆窗口与记忆块）
│  ├─ chatClient.ts         # SSE 流式、AbortController 注册表、错误映射、testConnection、requestCompletion
│  ├─ memory.ts             # 记忆纯逻辑：标记解析、流式过滤、去重、JSON 容错、提示词模板
│  ├─ memoryService.ts      # 记忆后台任务：兜底总结、向上沉淀、修正、任务锁与退避
│  ├─ ipc.ts                # 全部 ipcMain.handle 注册 + chat:send 编排
│  └─ transfer.ts           # 导出/导入（自有格式 + Dify 格式识别与映射、头像 base64 往返、导入报告）
├─ preload/index.ts         # contextBridge 暴露 window.api
└─ renderer/
   ├─ index.html            # CSP（仅生产构建注入）
   └─ src/
      ├─ App.tsx            # 视图切换、TabBar、流式事件订阅、Toast/确认弹窗宿主
      ├─ store/appStore.ts + chatStore.ts
      ├─ pages/ HomePage / MinePage / CardDetailPage / CardEditorPage / ChatPage / MemoryPage / SettingsPage
      ├─ components/ TabBar / SearchBar / CardItem / Avatar / SegmentedControl / ConfirmDialog / Modal / WorldbookEntryModal / CommonModelsModal / MarkdownText / Toast / icons
      ├─ utils/format.ts    # 相对时间、头像配色哈希、标题截断
      └─ styles/ theme.css（双配色变量）+ app.css
```

## 3. 数据模型

```ts
interface WorldbookEntry {
  id: string;          // uuid
  title: string
  content: string
  keywords: string[]   // UI 按 , 和 ，拆分
  order: number        // 升序，0 最高优先
  alwaysOn: boolean
}
interface Card {
  id: string; name: string
  avatar?: string      // 头像文件名 "<cardId>.<随机后缀>.<ext>"；无 = 占位
  systemPrompt: string // 角色设定（提示词正文），'' = 无
  prePrompt: string    // 前置词，'' = 无。与正文同属人设，只是分两段写；拼接顺序见 §6
  suffix: string       // 后置词，'' = 无。非空时作为**最后一条消息**发送，见 §6
  greeting: string     // 开场白，'' = 无
  worldbook: WorldbookEntry[]
  model?: string       // 可选：该卡指定的模型；空/缺省 = 用设置里的默认模型
  stream?: boolean     // 可选：该卡指定的输出方式；缺省 = 用设置里的默认（聊天页状态条可改）
  temperature?: number // 可选：该卡指定的温度（0–2）；缺省 = 用设置里的（聊天页「调节参数」面板可改）
  maxTokens?: number   // 可选：该卡指定的单次回复最大长度（1–131072）；缺省 = 用设置里的（同上）
  // 记忆设置（见 §9）：全部可选，缺省用 shared/memory.ts 里的默认值
  memoryEnabled?: boolean    // 缺省 true
  memoryRecentCount?: number // 「记忆设定」每次带 N 条历史消息，默认 6，2–50
  memoryShortLimit?: number  // 短期容量（字），默认 3000，200–20000
  memoryShortBatch?: number  // 短→长的条数阈值，默认 25，3–100
  memoryLongLimit?: number   // 长期容量（条），默认 20，2–100
  memoryLongBatch?: number   // 长→永久的条数阈值，默认 10，2–50
  createdAt: number; updatedAt: number
}
interface ChatMessage {
  id: string           // uuid；消息级操作（修改/删除/重发/分支）一律按它定位，不用数组下标
  role: 'user'|'assistant'
  content: string
  ts: number
  editedAt?: number    // 被改过的时间戳；无 = 没改过（界面上挂灰色「已修改」小字）
}
type MemoryLayer = 'short' | 'long' | 'permanent'
interface MemoryEntry {
  id: string
  content: string     // 一句话一条；硬上限 300 字
  source: 'ai' | 'summary' | 'consolidate' | 'user' | 'repair'
  sourceMessageIds: string[]  // 产生这条记忆的消息 id；分支时过滤「未来信息」；用户手写为 []
  createdAt: number
  updatedAt?: number
}
interface ConversationMemory {
  version: 1
  coveredCount: number        // messages[0..coveredCount) 的原文已被记忆接住
  short: MemoryEntry[]
  long: MemoryEntry[]
  permanent: MemoryEntry[]
  revision: number            // 每次记忆变更 +1，用于乐观并发
  lastRunAt?: number
  lastError?: string          // 最近一次自动整理失败的中文原因；成功后清空
  failCount: number
  retryAfter?: number         // 退避截止时间戳；未到点不自动重试
}
interface Conversation {
  id: string; cardId: string
  title: string        // 自动取首条用户消息前20字，否则"新对话"
  createdAt: number; updatedAt: number
  messages: ChatMessage[]
  memory?: ConversationMemory  // 缺省 = 空记忆、coveredCount 0（老对话读取时补齐，不主动改写文件）
  branchFrom?: { convId: string; title: string }  // 分支来源（标题 + 原对话 id），对话列表里显示「分支自 xxx」
}
interface MetaStore {
  favoriteIds: string[]       // 我的收藏
  favoritePinnedIds: string[] // 收藏内置顶
  historyIds: string[]        // 游玩历史（首次聊天收录顺序）
  historyPinnedIds: string[]  // 历史内置顶
  lastPlayedAt: Record<string, number>
}
interface Settings {
  temperature: number  // 默认 0.8，范围 0–2
  maxTokens: number    // 默认 2048，范围 1–131072
  stream: boolean      // 默认 true = 流式逐字显示；false = 非流式，整段一次返回
  currentProviderId: string  // 当前使用的供应商 id（= 规范化 baseUrl）；'' = 还没配过
}
interface Provider {
  id: string           // **就是规范化 baseUrl**（trim + 去尾部 /），作为身份与唯一标识
  baseUrl: string      // 原始写法，展示与请求都用它（请求前再归一）
  name: string         // 自定义名称，'' = 没起名。**只用于显示**：不参与 id / 去重 / 合并 / 请求
  apiKey: string
  model: string        // 这条供应商的默认模型，默认 deepseek-chat
  models: string[]     // 拉回来的可用模型名（已过滤+去重+按字母序）；[] = 还没成功获取过
  commonModels: string[]  // 挑出来的常用模型；[] = 没挑过（聊天页照旧列全部）。**不裁剪 models**
  modelsFetchedAt: number  // 上次成功获取的时间戳；0 = 从没成功过
  createdAt: number; updatedAt: number
}
```

**Provider 存储**（`data/providers.json`，`Provider[]`）：
- `id === normalizeUrl(baseUrl)`，天然去重：同一个地址只会有一条；保存时若地址撞上别的条目则合并（覆盖名称、Key 与模型）
- `name` 与 `commonModels` 都是**只跟这条记录走**的显示/筛选字段：`name` 纯显示（有名称显示名称，没名称显示接口地址），`commonModels` 只决定聊天页浮层列哪些模型。**绝不用 `commonModels` 裁剪 `models`**——`models` 永远是服务端返回的全量清单（重拉整表替换），用户的挑选结果必须单独存，否则会被下一次「获取模型列表」冲掉
- **旧数据兼容**（沿用「读时补齐、下次写才落盘」）：老 `providers.json` 里没有 `name` / `commonModels` → 读出来归一为 `''` / `[]`（等于「没起名」「没挑过」），不主动改写用户的文件
- 地址是空串时拒绝保存（中文报错）
- **旧数据迁移**：首次读取时若 providers.json 不存在，且 settings.json 里有 baseUrl/model，则自动生成第一条供应商（apiKey 一并带过来）并把 `currentProviderId` 指向它；settings.json 里残留的 baseUrl/apiKey/model/providerKeys 字段只用于这次迁移，此后读取忽略、下次保存设置时自然消失
- 删除当前使用中的供应商时，`currentProviderId` 落到剩余第一条；一条都不剩则为 `''`

### 记忆的归属、默认值与计数口径（`shared/memory.ts`）

- **按对话保存**：`Conversation.memory` 嵌在对话文件里，删除对话即随之删除；同一张卡的多个对话各存各的
- **默认值**（卡片级字段缺省时使用，全部可在卡片编辑页改）：
  - `memoryRecentCount` 6（2–50）：每次请求带最近 N 条历史消息
  - `memoryShortLimit` 3000（200–20000）：短期容量，按**字符数**
  - `memoryShortBatch` 25（3–100）：短→长的条数阈值
  - `memoryLongLimit` 20（2–100）：长期容量，按**条数**
  - `memoryLongBatch` 10（2–50）：长→永久的条数阈值
- **计数口径**：短期按字符数；长期、永久按条数；窗口按消息条数。都不是 token 精确值，界面注明「约」
- **单条上限**：所有记忆条目硬上限 **300 字**，超长截断加省略号
- **旧数据兼容**：老对话没有 `memory` → 读时补 `{ version:1, coveredCount:0, short:[], long:[], permanent:[], revision:0, failCount:0 }`，**不主动改写文件**；老卡片没有五个字段 → 按默认值处理。沿用「读时补齐、下次写才落盘」
- **归一与校验**：五个数字的合法性集中在一处（`resolveMemoryConfig` + `cards:save`），越界/垃圾值一律当「没设」回落到默认，不报错
- `coveredCount` 表示「前多少条消息已经写进记忆」，读取时一律 clamp 到 `messages.length`

### 卡片的外部格式与导入映射（`main/transfer.ts`）

**导出格式**（自有格式，文件可读、可手改）：

```jsonc
{
  "format": "ai-chat-cards",  // 格式标识，导入时据此识别
  "version": 1,
  "card": { /* Card 的全部字段；这里的 id 无意义，导入时会重新分配 */ },
  "avatarDataUrl": "data:image/png;base64,..."  // 可选；无头像则整个字段缺省
}
```

- 导出**不含对话记录**：对话是本地过程产物，不随卡走
- **卡片级记忆设置随 `Card` 一起导出/导入**（`memoryEnabled` 等五个字段）；**对话与三层记忆本身不导出**（它们属于对话，不属于卡片）
- 导入时**重新分配 `card.id`**（与「建分支」同规矩：世界书条目的 id 也要换新），避免覆盖已有卡；**卡片名称允许重复**——新手很可能把同一张卡导两遍，不该报错
- 头像文件名带随机后缀（见 §5），重复导入不会互相覆盖

**兼容格式：Dify 的 app 配置**（根对象或 `data` 下有 `model_config` 对象即认定）。字段映射：

| 外部字段 | 本地字段 | 说明 |
|---|---|---|
| `apps.name` / `name` | `name` | |
| `apps.icon`（http 地址） | `avatar` | 导入时下载存本地（超时 10 秒、>5MB 放弃）；失败留空并写进报告 |
| `model_config.opening_statement` | `greeting` | |
| `model_config.pre_prompt`（前置词） | `prePrompt` | **单独一个字段**，不折进正文（见下方硬规矩 ①） |
| `model_config.chat_prompt_config`（**JSON 字符串**） | `systemPrompt` | 逐块取 `text` 顺序拼接；块上的 `role` 不保留。**两种形状都要认**：`{"prompt":[…]}` 与裸数组 `[…]`——只认一种会把正文整段静默丢掉 |
| `model_config.completion_prompt_config`（**JSON 字符串**） | `systemPrompt` / `suffix` | `prompt.text` 接进人设；`post_prompt` → 后置词 |
| `model_config.world_book`（**整段文本**） | `worldbook` | **整段作为一条"常驻"条目**（标题「世界书」）——外部格式的世界书是一段文本，不是条目数组，不要试图按关键词切条 |
| `model_config.model.name` | `model` | |
| `apps.description` / `tags` / `author` 等展示字段 | — | 不导入（不属于聊天数据），在报告里说明已忽略 |

**三条硬规矩**：

1. **前置词、正文、后置词各有各的位置，不能一锅端**。前置词与正文**分两段存**（合并成一段会丢掉分段意图，也不方便单独改其中一段——2026-09-29 用户反馈「角色设定太笼统」后调整）；后置词必须待在消息序列的最后才有效，折进人设就失效（见 §6）。两个额外字段在编辑页都**默认折叠**——新手只看到「角色设定」一个框就够用，需要的人自己展开。
2. **不认识的字段一律进「导入报告」，绝不静默丢弃**。有些平台在导出时会**把提示词正文挖空、只留下长度字段**（如 `pre_length`、`world_book_length`）——报告必须直说「这张卡的提示词在文件里是空的」，否则用户会以为是本应用弄丢了。
3. **只处理用户选中的文件**：不联网抓取卡片、不调任何站点的接口、不做批量下载（需求见 requirements §6）。

**暂不支持**（同样进报告说明，不做静默处理）：

- Dify 的 **DSL YAML** 导出（`kind: app`）——解析 YAML 要引依赖，与「零依赖」原则冲突
- `conversation_histories_role` 的 `user_prefix` / `assistant_prefix`（给每条历史消息包前后缀）——本地按消息数组发送，没有对应位置
- `model_config.model.completion_params` 里**目前还没做卡片级**的那些采样参数（top_p / top_k / 存在惩罚 / 频率惩罚等）：**现阶段导入时忽略**，并在导入报告里说明。它们是「**还没做**」而不是「不做」——卡片级参数会陆续补齐（见 requirements 3.4），届时这些字段一并带过来。**本次已带过来的是** `temperature` → `Card.temperature`、`max_tokens` → `Card.maxTokens`

**导入报告**（`import:cards` 的返回，界面据此显示结果）：

```ts
interface ImportReport {
  fileName: string
  ok: boolean
  kind: 'own' | 'dify' | 'unknown'  // 识别出的格式
  cardId?: string                   // ok 时：新卡的 id（报告里那个「去编辑」按钮靠它跳转到编辑页）
  cardName?: string
  summary?: {                       // ok 时：装进来了什么
    promptChars: number             // 角色设定字数；**0 = 文件里本来就是空的**
    prePromptChars: number
    suffixChars: number
    worldbookEntries: number
    hasGreeting: boolean
  }
  warnings: string[]                // 灰色小字逐条列出：被挖空的正文、不认识的字段、头像下载失败…
  error?: string                    // 失败原因（中文）
}
```

### 可用模型列表的获取（`main/chatClient.ts` → `listModels(provider)`）

- **接口**：OpenAI 兼容的 `GET {接口地址}/models`。地址归一规则与 `chatCompletionsUrl` 同族：
  已以 `/models` 结尾则直接用；以 `/chat/completions` 结尾则先去掉再拼 `/models`；结尾是版本段（`/v1`、`/v4` 等）则补 `/models`；否则补 `/v1/models`
- **请求头**：`Authorization: Bearer <apiKey>`（部分服务商不校验，带上无害）；超时 15 秒
- **响应归一**（各家写法有差异，全部容错）：优先取 `data[].id`，其次 `data[].name`、`models[].id|name`、`data[]` 为纯字符串数组；其余形状一律忽略
- **过滤**：丢掉名字里含 `embedding` / `rerank` / `tts` / `whisper` / `speech` / `audio` / `dall-e` / `image` / `moderation` / `ocr` / `bge-` 的条目（这些不能聊天）；过滤是**宁松勿严**——滤错了用户还能手动输入模型名兜底
- **整理**：trim → 去重 → 按字母序排序（可预期、好找）
- **失败语义**：网络/HTTP 错误复用 §7 的中文映射，返回 `{ok:false, message, detail}` 而**不抛异常**（与 `settings:test` 一致，界面要同时显示中文结论与 API 原文）；成功但一条都没有 → `{ok:false, message:'这家服务商没有返回可用的模型'}`，但仍允许用户手动输入
- **调用时机**：① 供应商表单里点「获取模型列表」；② 保存供应商时先在界面层拉一次（显示「获取中…」，失败不拦保存，只提示）。主进程的 `providers:save` 保持纯本地快速，不做联网
- **保存**：成功的结果随 `providers:save` 一起落盘；**用户在表单里选的模型即使不在列表里也照常保存**（手动输入的兜底，不能丢）

### 消息的身份与消息级操作（`main/store.ts` + `main/ipc.ts`）

**为什么给消息加 id**：修改 / 删除 / 重新输出 / 建分支都要针对「某一条」下手。数组下标不行——删一条之后下标全体前移，React 的 key 也跟着乱。id 让定位稳定，`key={m.id}` 也让列表重排不会错位。

**旧数据兼容**（沿用 `Provider.models` 那套「读时补齐、下次写才落盘」）：`loadCardConvs` 读出来时，给缺 `id` 的老消息补一个**确定性**的 `legacy-<下标>-<ts>`。确定性是必须的——主进程和渲染层各自算一遍，必须得到同一个 id，否则操作会找不到目标。补齐只发生在内存里，**不主动改写用户的文件**；下次这条对话因为别的原因被保存时，id 自然写进文件。`editedAt` 缺省即「没改过」，无需补。

**消息级操作的落盘规则**（全部先查 `isStreaming`，正在回复时抛「正在回复中，请稍候」）：

| 操作 | 规则 |
|---|---|
| 改内容（`convs:update-message`） | 定位到那条 → 覆盖 `content`、`editedAt = now`。`dropAfter = true` 时先把这条之后的全部截掉。**不发起请求** |
| 删除（`convs:delete-message`） | `mode`：`'only'` 只删这条；`'reply-too'` 这条 + 紧随其后那条 assistant（撤回用，后面不是 assistant 就只删这条）；`'from-here'` 这条及之后全删 |
| 重新输出（`convs:regenerate`） | 先删（见下），再用 `messages[0..i-1]` 当历史发一次请求。`content` 有值时先把第 i 条的内容改掉（「修改用户消息并重来」复用这条路） |
| 建分支（`convs:branch`） | 复制 `messages[0..i]` 到一个新 Conversation，**每条重新生成 id**（新对话里的消息是独立个体，不该和原对话共用一个 id）；标题 `原标题 · 分支`（同样受 30 字上限）；写入 `branchFrom`。原对话完全不碰——**这条是唯一不查 `isStreaming` 的**：它只读原对话、往新对话里写，不会和进行中的流式回复抢同一条记录。界面上只给 AI 消息提供（用户要的就是这个），主进程不限 |

**`regenerate` 的两条路**（界面弹窗让用户选，两条都要真做）：

- `dropAfter: true` → 把第 i 条及其后全部删掉，新回复**追加在末尾**（和平时聊天一样）
- `dropAfter: false` → **只删第 i 条**，新回复**插回位置 i**（用 `Array.prototype.splice`，见 `appendAssistant` 的 `insertAt` 参数），后面的消息原样留在后面。请求本身两条路都一样：历史只取 `messages[0..i-1]`

**边界**：「重新输出」要求这条消息**前面还有消息**（对话第一条是开场白，前面是空的，没有可重发的东西）；界面上直接置灰，主进程也拦一道。

**剪贴板**：复制走主进程 `electron.clipboard.writeText`（新频道 `app:copy-text`），**不用 `navigator.clipboard`**——后者依赖文档焦点，在 Electron 里偶发不生效，而非技术用户遇到「点了复制没反应」极难自查。

### 存储布局（userData = %APPDATA%\ai-chat-cards，主进程显式 setPath 保证 ASCII 路径）

```
ai-chat-cards/
├─ data/cards.json          # Card[]
├─ data/meta.json           # MetaStore
├─ data/settings.json       # Settings
├─ data/providers.json      # Provider[]（供应商配置，API 配置栏目）
├─ conversations/<cardId>/<convId>.json   # 每对话一文件
└─ avatars/<cardId>.<随机后缀>.<ext>   # 头像原图
```

- **每对话一文件**：同卡多对话可并发流式、独立原子写、删除即 unlink
- **头像文件名带随机后缀**：编辑器里「选了新图又取消」不会覆盖已保存卡片的头像——**卡片记录里的 avatar 字段是唯一真相**。保存时若头像字段变了才删旧文件；启动时清理无人引用的孤儿文件（上限一次目录扫描）
- **原子写**：写临时文件 + rename；每文件一个 Promise 写队列防并发交错
- **首次运行种子数据**：自动创建一张示例聊天卡（带 2 条世界书：一条关键词触发、一条常驻），可随时删除

## 4. IPC 契约

**安全**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`will-navigate` 拦截、`setWindowOpenHandler` 拒绝、单窗口、去菜单；CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: app-media:; connect-src 'self' ws:`（仅生产构建注入，开发模式 react-refresh 需要内联脚本）。唯一桥接是 preload 暴露的 `window.api`。

### 调用频道（invoke / handle）

| 频道 | 请求 → 响应 | 要点 |
|---|---|---|
| `cards:list` | — → Card[] | createdAt 倒序 |
| `cards:save` | Card → Card | 新建时分配 uuid 和时间戳；`model` 空串归一为缺省、`stream` 非布尔归一为缺省（聊天页状态条切换即走这里落盘） |
| `cards:delete` | cardId → void | 连带删除 conversations/<id>/ 与头像文件 |
| `avatar:pick` | cardId → {avatar?} | 文件对话框；>5MB 抛中文错误。只复制文件并返回新文件名，**不改卡片记录、不删旧图**（等 cards:save 对比落库时再删旧图） |
| `meta:get` | — → MetaStore | |
| `meta:update` | Partial<MetaStore> → MetaStore | 渲染层只传变更的数组键 |
| `settings:get` | — → Settings | |
| `settings:save` | Settings → Settings | 校验温度 0–2、maxTokens 1–131072；`stream` 归一为布尔（缺省 = true，兼容旧数据）；`currentProviderId` 若指向不存在的供应商则回落为第一条（无则为 `''`） |
| `providers:list` | — → Provider[] | 含读取时的旧数据迁移 |
| `providers:save` | Provider（id 可空=新建）→ Provider | 校验 baseUrl 非空、apiKey 允许空（空 Key 只能保存不能测试）；`id = normalizeUrl(baseUrl)`；地址撞已有条目则覆盖合并；保存后自动把 `currentProviderId` 指向它（新建即启用，符合「刚配好就要用」的直觉）。**不联网**：`models` / `modelsFetchedAt` 由渲染层先拉好再随请求带进来（缺字段归一为 `[]` / `0`）；`name` / `commonModels` 也随整个对象一起落盘（缺字段归一为 `''` / `[]`），**没有新增频道** |
| `providers:delete` | providerId → {currentProviderId} | 删除后返回新的当前供应商标识，渲染层据此刷新 |
| `providers:setCurrent` | providerId → Settings | 切换使用中的供应商（写进 settings.currentProviderId） |
| `providers:fetch-models` | Provider → {ok, models, message?, detail?} | 用**传入的这条**（可还没保存）去拉 `GET /models`，给新建/编辑时当场用。**不抛异常**，失败返回 `{ok:false, message, detail}`；成功返回整理好的 `models`（已过滤去重排序） |
| `settings:test` | Provider → {ok, message?, detail?} | 非流式 max_tokens:8 探测，用**传入的那条供应商**（这样新建/编辑时能先测再存）。**不抛异常**：失败返回 `{ok:false,message,detail}`，这样界面既能显示中文结论也能显示 API 原文（异常过桥会丢掉 detail） |
| `convs:list` | cardId → ConvSummary[] | {id,title,createdAt,updatedAt,messageCount}，updatedAt 倒序 |
| `convs:get` | (cardId, convId) → Conversation\|null | 进聊天页时读取完整消息；对话已被删则返回 null |
| `convs:create` | cardId → Conversation | 有开场白则作为首条 assistant 消息 |
| `convs:rename` | (cardId, convId, title) → Conversation | |
| `convs:delete` | (cardId, convId) → void | 仅删对话文件，不动收藏/历史 |
| `convs:update-message` | (cardId, convId, messageId, content, dropAfter) → Conversation | 改一条消息的文字。`content` 去空白后不能为空；`dropAfter` = 连同这条之后的一起截掉。**不发起请求** |
| `convs:delete-message` | (cardId, convId, messageId, mode) → Conversation | `mode`：`'only'` / `'reply-too'`（这条 + 紧随的 assistant，撤回用）/ `'from-here'`（这条及之后）。找不到 messageId 抛「这条消息已经不在了，请重开对话看看」 |
| `convs:regenerate` | (cardId, convId, messageId, {dropAfter, content?}) → {ok} | 删掉这条（`content` 有值则先改内容）→ 重新请求，回复照旧走推送事件。`dropAfter:false` 时新回复**插回原位置**。这条前面没有消息（对话第一条）时抛中文错误 |
| `convs:branch` | (cardId, convId, messageId) → Conversation | 复制到这条为止建新对话（每条重新生成 id），标题 `原标题 · 分支`，写 `branchFrom`；原对话不碰。**记忆按 §9.8 的规则复制快照**，过滤分支点之后才产生的条目 |
| `memory:get` | (cardId, convId) → `{ memory, messageCount, busy }` | 记忆页用；旧对话返回空记忆；`busy` = 该对话正在跑记忆任务 |
| `memory:add-entry` | (cardId, convId, layer, content) → `{ memory }` | 手动添加；空文本拒绝；单条 300 字；`revision++` |
| `memory:update-entry` | (cardId, convId, layer, entryId, content) → `{ memory }` | 手动修改；`revision++` |
| `memory:delete-entry` | (cardId, convId, layer, entryId) → `{ memory }` | 手动删除；`revision++` |
| `memory:clear-layer` | (cardId, convId, layer) → `{ memory }` | 清空一层；**不改变 `coveredCount`** |
| `memory:organize` | (cardId, convId, mode?: `'normal'` \| `'rebuild'`) → `{ ok }` | 手动「现在整理一次」/「从头整理」；立即返回，进度走 `memory:event`。`rebuild` = 清空三层 + `coveredCount = 0` 后从头整理 |
| `memory:refresh` | (cardId, convId, anchorIndex?) → `{ ok }` | 改动已覆盖旧消息后的「一起整理记忆」；立即返回，结果走事件 |
| `app:copy-text` | text → void | 主进程 `clipboard.writeText`（理由见 §3 消息级操作一节） |
| `chat:send` | (cardId, convId, text) → {ok} | 立即返回，流式经推送事件 |
| `chat:abort` | (cardId, convId) → void | 中止 fetch，半截文本已持久化 |
| `export:card` | cardId → {path\|null} | 保存对话框，默认名 `<卡名>.json`（卡名里的非法文件名字符先替换成 `_`）；写自有格式（含头像 base64，见 §3「卡片的外部格式与导入映射」）。用户取消返回 `null` |
| `import:cards` | — → ImportReport[] | 打开对话框**多选** JSON；逐个识别格式（自有 / Dify / 认不出）并转换落盘；**一张失败不影响其余**。返回每张一张报告（结构见 §3），界面据此显示导入结果。**不抛异常**（失败写在报告的 `error` 里） |

### 推送频道（main → renderer，`chat:event` 与 `memory:event`）

```ts
type ChatEvent =
  | { type: 'delta';   cardId: string; convId: string; text: string }
  | { type: 'done';    cardId: string; convId: string; fullText: string }  // 已持久化（已剥离记忆标记）
  | { type: 'error';   cardId: string; convId: string; message: string; detail?: string }
  | { type: 'aborted'; cardId: string; convId: string; partial: string }   // 已持久化（已剥离记忆标记）

type MemoryEvent =
  | { type: 'updated'; cardId: string; convId: string }
  | { type: 'busy';    cardId: string; convId: string; busy: boolean }
  | { type: 'error';   cardId: string; convId: string; message: string; detail?: string }
  | { type: 'noticed'; cardId: string; convId: string; message: string }  // 只写入记忆、没有正文时的 toast
```

`MemoryEvent` 只推「有变化」，不推完整记忆对象；记忆页收到 `updated` 后重新 `memory:get`。

### preload API（window.api）

`cards.{list,save,delete,pickAvatar}`、`meta.{get,update}`、`settings.{get,save,test}`、`providers.{list,save,delete,setCurrent,fetchModels}`、`convs.{list,get,create,rename,delete,updateMessage,deleteMessage,regenerate,branch}`、`memory.{get,addEntry,updateEntry,deleteEntry,clearLayer,organize,refresh,onEvent(cb)→unsubscribe}`、`chat.{send,abort,onEvent(cb)→unsubscribe}`、`copyText(text)`、`io.{exportCard,importCards}`。

聊天数据流：渲染层 `chat.send()` 拿到 `{ok}` 后乐观显示用户气泡，随后只消费 `chat:event` 推送；`delta` 累加进气泡，`done`/`aborted` 定稿，`error` 在气泡上方显示中文横幅（`detail` 作灰色小字）。渲染层的流式状态以事件为准，不依赖 send 的返回值。

`done` / `aborted` / `error` 到达后的收尾（重读对话让新回复上屏 + 撤掉流式气泡）必须写在**同一个 `set`** 里（`chatStore.settleStream`）。分两次 set 会漏出一帧「回复已经排版好、打字气泡却还在」的中间态——同一条回复显示两份。两次 set 之间隔着一次 IPC 往返，没人保证它们落在同一帧里（用 MutationObserver 逐帧抓到过）。

渲染层约定：`pickAvatar` 返回的文件名只存编辑器内存，「保存」才写进卡片；「移除头像」同理只改内存字段，保存时由主进程删旧图。

渲染层约定（Markdown 排版，`components/MarkdownText.tsx`）：只用于**已落盘的 AI 回复**（流式那半截照旧纯文本）。用 `react-markdown` 把内容转成 **React 元素**，全程**不使用** `dangerouslySetInnerHTML` / `innerHTML`，内容里的原始 HTML（`<script>`、`<img onerror=…>`）默认**不解析**、**按纯文字原样显示**（既不执行也不隐藏），因此不需要消毒库。链接渲染成 `<span>` 而不是 `<a>`、图片渲染成占位文字，所以**不放宽 CSP**（`img-src` 保持 `'self' data: app-media:`）、**不打开任何外部地址**。`content` 字段始终是**原始 Markdown 文本**——「复制」「修改」「撤回」、对话标题生成、世界书注入拿到的都是原文，渲染只是展示层的单向转换，**不涉及数据迁移**。

## 5. 头像管线

1. 选图 → 对话框（png/jpg/jpeg/webp/gif）→ 超 5MB 拒绝 → 原样 copyFile 到 `avatars/<cardId>.<随机后缀>.<ext>` → 返回新文件名（此时**不**改卡片记录、**不**删旧文件）
2. 编辑器只把新文件名暂存在内存；点「保存」时 cards:save 对比记录中的旧文件名，不同才删旧文件。取消编辑 → 新文件成为孤儿，下次启动自动清理
3. 显示：自定义协议 `app-media://`（注册为 privileged+standard），`protocol.handle` 内做路径穿越防护（resolve 后必须仍在 avatarDir 内），`net.fetch(pathToFileURL(...))` 返回；渲染层 `<img src="app-media://local/avatars/xxx.png">`，开发（http 源）与打包（file 源）下行为一致；文件名含随机后缀，天然免疫浏览器缓存（换图无需加时间戳）
4. 无头像：色块 + 名字首字，颜色 = 8 色调色板按 card.id 哈希取模
5. 导出：头像读为 `avatarDataUrl`（data:image/...;base64）写入 JSON；导入：解码回 avatars/ 目录，失败回退占位并写进导入报告
6. **外部卡的头像是 http 地址时**：先下载（超时 10 秒、超 5MB 放弃）再走上面同一条路；失败则留空用占位，并写进报告。这是导入过程里**唯一的联网动作**，且只针对用户选中的文件里写着的地址

## 6. 世界书注入算法 + 消息组装（纯函数，main/worldbook.ts）

1. **扫描窗口**：**实际发送的**最近 8 条历史消息 + 当前用户消息，拼接转小写（被记忆窗口截掉的旧消息不再参与扫描——它们对 AI 来说已经「忘记」了）
2. **匹配**：条目激活 = `alwaysOn` 或任一关键词为窗口子串（关键词 trim + 小写，空关键词忽略）
3. **排序**：激活条目按 `order` 升序（平局按标题），常驻与触发条目同一规则，按 id 去重
4. **首条 system**：`[世界书条目]\n# 标题\n内容...` 拼块，与**前置词**、**角色设定（正文）**合并，顺序固定为 `世界书块 + '\n\n' + prePrompt + '\n\n' + systemPrompt`（任一为空则跳过那一段）
   - 前置词排在正文**前面**：它是「角色是谁」的总纲，正文是展开；顺序反了读起来会别扭
5. **历史窗口**：`memoryEnabled !== false` 且对话有记忆时：
   ```ts
   const start = memoryWindowStart(history.length, memory.coveredCount, config.recentCount)
   // = Math.min(Math.max(0, len - recentCount), Math.max(0, Math.min(coveredCount, len)))
   ```
   发送 `history.slice(start)`；关闭记忆或 `coveredCount === 0` 时 `start = 0`，与改动前**逐字一致**。
   - `history.length` 必须是**不含当前用户消息**的历史条数
   - 语义 = 最近 N 条 ∪ 尚未写进记忆的旧消息：`coveredCount` 以内的旧原文可以省略，但「还没被记忆接住」的一条都不能丢
6. **记忆块**（启用且对话有记忆时）：在历史之后、当前用户消息之前插入**单独一条 system**：
   - 顺序固定为 `永久 → 长期 → 短期`（越靠近当前回合的越新）；空层不输出
   - 三层都空时只输出一句「（暂时还没有记住的事）」+ 写入规则
   - 写入规则告诉 AI：值得记的新信息用 `【记忆】一句话事实【/记忆】` 写在回复末尾，每轮最多 3 条（解析端最多接受 5 条），没有新信息就不写
   - 记忆块**不折进首条 system**：首条 system 管「你是谁」，记忆块管「发生了什么」
   - `memoryEnabled === false` 时**整块不插入**
7. **当前用户消息**：`currentText` 非空时追加
8. **后置词**（`card.suffix` 去空白后非空时）：作为**最后一条 system 消息**追加在用户消息之后。它必须待在消息序列的**末尾**才有效——很多卡用它约束输出格式（"只输出 JSON""不要旁白"这类），折进人设里就不灵了。为空则**一条都不加**，不留空消息
   - 首条 system 与末条 system 的分工：**开头管"你是谁"，结尾管"这条回复该怎么写"**
9. **`buildMessages(card, history, currentText?, memoryContext?)`**：
   - `currentText` **可省略**——「重新输出」是让 AI 对已有的历史重答一遍，没有新的用户输入，不该凭空追加一条 user 消息
   - `memoryContext = { memory?, recentCount, enabled }`；缺省时行为与改动前完全一致
   - 完整顺序：`首条 system → 最近历史窗口 → 记忆 system → 当前用户消息 → 后置词`

## 7. 聊天请求（流式 / 非流式，main/chatClient.ts）

- **并发**：`Map<cardId:convId, AbortController>` 注册表，同对话重复 send 抛"正在回复中"；不同对话（含同卡）可并行
- **接收方式**（`settings.stream`，默认流式）：
  - **流式**：请求体 `stream: true`，按下面的 SSE 规则逐块推送 `delta` 事件
  - **非流式**：请求体 `stream: false`，整段 JSON 一次返回，取 `choices[0].message.content`（兼容 `delta.content` / `text` / 内容数组），**不发 `delta`，只发一个 `done`**；界面在等待期间显示三点跳动的等待气泡，收到后整段出现
  - 两条路径的持久化、`error` 映射、中止语义完全一致；非流式被中止时尚未拿到文本，`aborted` 的 partial 为空（不算错误，不落盘）
- **URL 归一**（对新手友好，容忍粘贴各种写法）：trim baseUrl、去尾部 `/`；已以 `/chat/completions` 结尾则直接用；结尾是版本段（`/v1`、`/v4` 等）则补 `/chat/completions`；否则补 `/v1/chat/completions`
- **供应商与模型的来源**（每条消息发送时现算）：
  - **供应商**（接口地址 + API Key）= `settings.currentProviderId` 指向的那条；找不到则报「还没有配置供应商，请到 API 配置里添加」
  - 请求 `model` = 卡片的 `card.model`（非空时）否则当前供应商的 `provider.model`；两者都空则报「请先填写模型名称」
  - **卡片不绑定供应商**：`Card` 里只有一个模型名，走哪家永远由全局的 `currentProviderId` 决定。所以聊天页切换供应商时，若这张卡的模型不在新供应商的 `models` 里（且新供应商 `models` 非空），渲染层顺手把 `card.model` 清空（回落到新供应商的默认模型）并提示一句——否则下一条必然是 404
  - 请求 `stream` = 卡片的 `card.stream`（是布尔时）否则设置里的 `settings.stream`。**必须用 `typeof x === 'boolean'` 判断**，不能写 `card.stream ?? default` 之外的 falsy 判断——`false` 是有效值
  - 请求 `temperature` / `max_tokens` = 卡片的 `card.temperature` / `card.maxTokens`（是数字时）否则设置里的 `settings.temperature` / `settings.maxTokens`。**同样必须用 `typeof x === 'number'` 判断**——`0` 是有效温度，靠真值判断会把「本卡设成 0」错当成「没设」而回落到全局
  - 四个卡片级参数（`model` / `stream` / `temperature` / `maxTokens`）的归一与校验都在 `cards:save` 里做一处，读出来就能直接用，不在请求时兜底
  - 在 ipc.sendChat 里算好，作为显式参数传给 `requestChat(cardId, convId, provider, model, stream, temperature, maxTokens, messages, onDelta)`
  - `testConnection` 固定用非流式小请求（max_tokens:8），测的是**传进来的那条供应商自己的模型**，不受卡片设置与「接收方式」影响
- **SSE 解析**：手写（fetch + ReadableStream + TextDecoder，按 `\n\n` 分块、`data:` 行、`[DONE]` 终止、取 `choices[0].delta.content`），零依赖
- **持久化**：send 时先存用户消息（首条自动设标题、首次聊天自动收录历史），流结束后存 assistant 消息（完整或半截）
- **错误映射（中文优先）**：401→"API Key 无效或未填写"；403→"没有访问权限"；404→"接口地址或模型名称不正确"；429→"请求太频繁，请稍后再试"；400/其他→透传 API 的 error.message；网络错误→"无法连接服务器，请检查网络和接口地址"；原始技术信息放灰色小字 detail
- **退出安全**：`before-quit` 遍历活跃流，abort 并把已累计文本同步写入对话文件
- **记忆后台请求（`requestCompletion`，见 §9）**：非流式、一次拿完整文本，**不注册 `cardId:convId` 流式锁**——所以记忆整理与正常聊天可以同时进行；固定 `temperature: 0.2`、`max_tokens: 4096`、超时 60 秒，复用本节的 URL 归一、请求头与错误映射

## 8. 打包

- electron-builder：appId `com.aichatcards.app`、productName `AI聊天卡`、targets = NSIS(x64, 一键安装, 桌面快捷方式) + portable、`files: ['out/**']` + asar
- 开源合规：`LICENSE`（MIT）与 `THIRD-PARTY-NOTICES.md` 通过 `extraResources` 打进安装包 `resources/`；第三方声明由脚本按「运行时真正打进 bundle 的依赖」生成（含 MIT / ISC / BSD-3-Clause 全文与版权行），Electron 与 Chromium 的许可文件由 electron-builder 自动附带
- 图标：build/icon.png（≥256×256，builder 自动转 .ico）
- `.npmrc` 内置国内镜像（registry/electron_mirror/electron_builder_binaries_mirror → npmmirror）；备用环境变量：ELECTRON_MIRROR、ELECTRON_BUILDER_BINARIES_MIRROR
- 未签名 exe 首次运行 SmartScreen 提示，README 已说明
- **GitHub Release 的 asset 文件名不支持中文**（实测上传 `测试中文-1.0.0.txt` 会变成 `-1.0.0.txt`，中文被直接丢弃）。所以本地产物用中文名，上传到 Release 时改用 ASCII 名：`AI-Chat-Cards-1.0.0-Setup.exe` / `AI-Chat-Cards-1.0.0-Portable.exe`

## 9. 记忆系统（三层记忆，main/memory.ts + main/memoryService.ts）

> 产品规格见 requirements 3.9；本节是实现算法与边界。数据模型见 §3，请求组装见 §6，IPC 见 §4。

### 9.1 归属、默认值与归一

- 记忆**按对话**保存在 `Conversation.memory`；删除对话即删除记忆
- 卡片级配置全部可选，由 `shared/memory.ts` 的 `resolveMemoryConfig(card)` 归一：

  | 字段 | 含义 | 默认 | 范围 |
  |---|---|---|---|
  | `memoryEnabled` | 启用记忆 | `true` | 布尔 |
  | `memoryRecentCount` | 每次带最近 N 条历史 | 6（用户和 AI 的消息各算一条） | 2–50 |
  | `memoryShortLimit` | 短期容量（字） | 3000 | 200–20000 |
  | `memoryShortBatch` | 短→长条数阈值 | 25 | 3–100 |
  | `memoryLongLimit` | 长期容量（条） | 20 | 2–100 |
  | `memoryLongBatch` | 长→永久条数阈值 | 10 | 2–50 |

- 越界/垃圾值当「没设」，回落到默认；不报错。归一集中在 `cards:save` 与 `resolveMemoryConfig` 一处
- 单条记忆硬上限 **300 字**；超出截断加省略号
- 老对话读时补齐空记忆（`version:1, coveredCount:0, short:[], long:[], permanent:[], revision:0, failCount:0`），**不主动改写文件**

### 9.2 请求窗口与注入

- `memoryWindowStart(len, coveredCount, recentCount) = min(max(0, len - recentCount), clamp(coveredCount, 0, len))`
  - `len` 不含当前用户消息；普通发送传 `conv.messages.slice(0, -1).length`，重新输出传 `prepareRegenerate` 返回的历史长度
  - `coveredCount = 0` 或记忆关闭 → `start = 0`（全量历史，与改动前逐字一致）
- 记忆块是**单独一条 system**，位置在最近历史之后、当前用户消息之前；顺序永久 → 长期 → 短期
- 记忆块文本（约 120–180 字，见 §6）每次请求都带写入规则，AI 才知道怎么用 `【记忆】…【/记忆】`
- 世界书扫描只看**实际发送的最近 8 条** + 当前用户消息

### 9.3 自动写入（AI 标记）

**解析**（`main/memory.ts: parseMemoryMarkers`）：

1. 只处理 assistant 回复；用户消息不解析
2. 支持 `【记忆】…【/记忆】` 与 `[记忆]…[/记忆]`
3. **代码围栏内不解析**：维护 ``` 开闭计数，围栏里的标记当普通文字
4. 完整标记取出后按行拆成多条；`trim`、丢弃空条目、单条截到 300 字
5. **未闭合**：从最后一个未闭合标记起到文本末尾丢弃，不写记忆；`hadUnclosed = true`
6. **去重**：规范化（去空白/中英文标点、转小写）后，完全相同或一方包含另一方视为重复；先同轮去重，再与现有短期条目去重
7. 一轮最多接受 5 条（提示词要求 3 条）

**流式过滤**（`MemoryFilter`）：

- 不能只在落盘时剥离，否则打字过程中用户会先看到 `【记忆】`
- `push(chunk, emit)` 内部维护缓冲区：不在标记内时，保留末尾可能是标记前缀的最长后缀（如「【记」），其余立即 emit；进入标记后只累积、不 emit；`finish()` 时未闭合的内容丢弃并标记
- 落盘、`done` / `aborted` 事件、气泡显示都用 `cleaned` 文本；**用户消息与记忆正文都不受影响**

**持久化**：

- 条目与 assistant 消息**同一次 `saveConversation`** 写入；`source: 'ai'`，`sourceMessageIds = [上一条用户消息 id, 本条 assistant 消息 id]`
- 只有标记没有正文：**不插入空 assistant 消息**，发 `done` + `memory:event`，界面 toast「AI 把这条回复写进了记忆」
- aborted / error 半截：闭合条目照写，未闭合丢弃；已落盘半截文本必须是清理后的
- **自动写入不推进 `coveredCount`**：标记只是顺手记录，不能代表这段原文已被完整总结；只有兜底总结成功才推进

### 9.4 兜底总结

**触发**（每轮 assistant 落盘后）：

```ts
const len = conv.messages.length
const overflow = len - recentCount - coveredCount
const batch = Math.max(recentCount, 4)
if (overflow >= batch) {
  const start = coveredCount
  const end = Math.min(len - recentCount, start + 30)
  summarizeChunk(start, end)
}
```

- 「最近 N 条」永远保留原文；只总结已掉出窗口且未覆盖的消息
- 单次最多 30 条或 6000 字（先到先停）

**请求**（`requestCompletion`）：

- 非流式，`temperature 0.2`、`max_tokens 4096`、超时 60 秒；模型 = 卡片模型或供应商默认模型
- system：「你是记忆整理助手。只输出 JSON：`{"entries":["一句话事实"]}`。每条一句话；只写身份、关系、承诺、重要事件、喜好、约定；不写寒暄、动作、猜测；最多 12 条；每条不超过 300 字。」
- user：待整理对话片段 + 已有短期记忆（要求不重复）

**应用**（乐观并发）：

1. 重新读取对话，校验 chunk 内每条消息的 `id` 与 `editedAt` 仍在且未变；有变化则放弃本次应用
2. 条目去重后追加到 `short`（`source: 'summary'`，`sourceMessageIds` = chunk 内消息 id）
3. `coveredCount = max(coveredCount, chunk 末尾位置)`；`revision++`、`lastRunAt=now`、`failCount=0`、清除 `lastError`
4. 空数组也算成功：推进 `coveredCount`，记忆页显示「已整理 N 条」
5. 推送 `memory:event { type:'updated' }`

**失败**：不推进 `coveredCount`；`failCount++`，`retryAfter = now + min(60s * 2^(failCount-1), 15min)`；写 `lastError`；推 `error` 事件。

### 9.5 向上沉淀（25→1、10→1）

**短期 → 长期**：

- 触发（谁先到算谁）：
  - `short.length >= shortBatch`（默认 25）
  - `memoryChars(short) > shortLimit`（默认 3000 字）
- 取**最早的** `min(shortBatch, short.length)` 条（至少 1 条），让 AI 合成 **1 条长期记忆**（压缩后的故事/设定）
- 提示词：合并重复、新信息覆盖旧信息、删琐碎；只留身份/关系/事件/偏好/约定；输出 `{"long":"……"}`（也接受 `{"long":["……"]}`，统一取第一条或拼接后截到 300 字）
- 成功后：从短期删除被合并条目；长期追加 1 条（`source: 'consolidate'`，`sourceMessageIds` = 被合并条目来源的并集）
- 若短期仍然超限：**下一轮**再整理，一轮最多一次，避免刷请求

**长期 → 永久**：

- 触发（谁先到算谁）：
  - `long.length >= longBatch`（默认 10）
  - `long.length > longLimit`（默认 20，安全网）
- 取最早的 `min(longBatch, long.length)` 条，合成 **1 条永久记忆**
- 提示词：只留身份、关系、长期设定、重大转折；永久层尽量稳定
- 成功后：长期删除被合并条目；永久追加 1 条

**通用规则**：

- 沉淀是**覆盖型**操作：请求前记下 `revision`，应用时不一致（用户中途改过记忆）则放弃结果并稍后重试，绝不覆盖用户刚改的内容
- 解析失败、或输入有内容但输出为空 → 视为失败，**原记忆完全不变**
- 永久层没有硬上限；记忆页超过 20 条时给灰色提醒
- 手写条目与 AI 条目一视同仁，都参与合并/改写/清理

### 9.6 修正与重建

- `memory:refresh(cardId, convId, anchorIndex?)`：输入当前三层记忆 + 修改点附近 ±10 条（再拼最近 20 条，总字数上限 6000），输出完整三层 JSON；用于「改/删/重发一条已被覆盖的消息」。**best effort**，不承诺完整重算
- `memory:organize(mode:'rebuild')`：清空三层 + `coveredCount = 0`，再按 9.4 的 chunk 从头整理；用于分支后清理、或用户主动「从头整理」
- 两者都走同一套任务锁、退避、JSON 容错与 `revision` 校验

### 9.7 任务调度、并发、失败

- `memoryJobs: Map<cardId:convId, { controller, rerun }>`：同一对话同一时刻只跑一个任务；忙时只置 `rerun`，结束后再跑一轮
- 一轮任务最多 3 步：兜底总结 → 短→长 → 长→永久；每步成功才继续
- 记忆任务与聊天**完全隔离**：用 `requestCompletion`，不占用流式锁；总结时继续聊天不会报「正在回复中」
- 所有记忆「读 → 改 → 写」走 `withConvLock(cardId, convId, fn)`，后台任务与用户编辑串行
- 用户编辑记忆时若任务在跑：拒绝并提示「正在整理记忆，请稍候」；消息操作不受影响
- 失败不弹聊天横幅；聊天页「记忆」入口显示小红点，记忆页显示中文原因与重试
- `before-quit` 调 `stopAllMemoryJobs()`，abort 并等待落盘

### 9.8 `coveredCount`、消息操作与分支

**消息操作后的水位调整**：

```ts
function removeCoveredRange(coveredCount: number, start: number, count: number): number {
  const overlap = Math.max(0, Math.min(coveredCount, start + count) - start)
  return Math.max(0, coveredCount - overlap)
}
```

| 操作 | `coveredCount` |
|---|---|
| `deleteMessage('from-here')` | `min(coveredCount, idx)` |
| `deleteMessage('only')` | `removeCoveredRange(coveredCount, idx, 1)` |
| `deleteMessage('reply-too')` | 按实际删除条数调用 |
| `updateMessage(dropAfter=true)` | `min(coveredCount, idx)` |
| `updateMessage(dropAfter=false)` | 若 `idx < coveredCount` 且内容有变 → `min(coveredCount, idx)`；否则不变 |
| `prepareRegenerate` | `min(coveredCount, keep)`；目标是已覆盖的用户消息且内容有变时再 `min(coveredCount, idx)` |
| `appendAssistant` | 不变；`insertAt < coveredCount` 时 `coveredCount = insertAt` |

**分支复制（防未来信息泄漏）**：

1. 只复制 `sourceMessageIds` 全部落在分支前缀内的条目；`source === 'user'` 的条目始终复制
2. 被丢弃的条目若包含前缀内的来源，把 `coveredCount` 退到最早的那个来源下标——宁可重发原文，也不静默丢
3. 来源不明（`sourceMessageIds` 为空且不是用户条目）的条目不复制，`coveredCount = 0`
4. 复制后的条目换新 id；`coveredCount = min(原 coveredCount, 分支消息数, safeCovered)`

### 9.9 风险与已知限制

1. **N=6 很小**：并集规则保证不丢未总结内容，但整理滞后时单次请求的 token 会临时变多
2. **额外请求成本**：兜底总结大约每 6 条新消息一次；沉淀每 25 条短期一次；界面必须提示会额外调用 AI
3. **角色模型不一定守标记**：兜底总结是主保险；解析对未闭合、多条、空正文都做容错
4. **记忆漂移/矛盾**：靠沉淀提示词「新信息覆盖旧信息」+ 用户可编辑兜底
5. **分支的未来信息泄漏**：用 `sourceMessageIds` 过滤；混合条目被丢弃时 `coveredCount` 回退
6. **超长对话追赶**：兜底一次最多 30 条/6000 字，老对话需要几次回复才追平
7. **永久层无硬上限**：界面显示条数并在超过 20 条时提醒，不自动裁剪
8. **注入体积**：默认上限下记忆总量约 1 万–1.5 万字；超过 1.2 万字时记忆页给「小上下文模型可能放不下」的灰色提醒
9. **记忆任务进行中不能编辑记忆**：会提示「正在整理记忆，请稍候」，这是有意的并发保护
10. **五个参数都在卡片编辑页可改**：改完从下一条消息开始生效；参数值会随 `Card` 导出/导入，但对话与记忆本身不导出
