# 技术方案

> 技术选型、数据模型、接口契约的权威标准。版本升级需先改本文档再动 package.json。
> 最后更新：2026-09-19

## 1. 技术选型（版本固定）

| 包 | 版本 | 说明 |
|---|---|---|
| electron | 44.1.1 | 内置 Node ≥22：全局 fetch、randomUUID、protocol.handle，无需 axios/eventsource |
| electron-vite | 5.0.0 | 单配置管理 main/preload/renderer，React HMR |
| vite | 7.3.6 | 不可升 vite 8（与 electron-vite 5 不兼容） |
| @vitejs/plugin-react | 5.2.0 | 6.x 需 vite 8，固定 5.x |
| react / react-dom | 19.2.8 | UI 框架 |
| zustand | 5.0.15 | 状态管理：导航 + 数据缓存 + 流式状态 |
| electron-builder | 26.15.3 | 打包 NSIS 安装包 + 便携版 |
| typescript | 5.9.3 | 不用 7.0（全新原生编译器，工具链风险） |
| @types/react / @types/node | 19.2.18 / 26.4.1 | 仅类型 |

**关键决策**：
- **导航用 zustand 状态机，不用 react-router**：底部 Tab + 返回栈，桌面应用无需 URL
- **所有依赖放 devDependencies**：electron-vite 全量打包进 out/，安装包不含 node_modules
- package.json 不设 `"type":"module"`：main/preload 走 CommonJS 成熟路径
- **零原生模块**（无 better-sqlite3 等），持久化用主进程 JSON 文件
- 开发机需 Node ≥ 22.12

## 2. 目录结构

```
src/
├─ shared/types.ts          # 全部接口/IPC 频道常量/ChatEvent 联合类型/默认值（唯一真源）
├─ main/
│  ├─ index.ts              # 窗口(1100×750)、安全开关、app-media:// 协议、退出时保存半截回复
│  ├─ store.ts              # JSON 持久化层（原子写、每文件写队列、缓存、首次运行示例卡）
│  ├─ providers.ts          # 供应商配置的读写与迁移（providers.json）
│  ├─ worldbook.ts          # 世界书注入算法 + 消息组装
│  ├─ chatClient.ts         # SSE 流式、AbortController 注册表、错误映射、testConnection
│  ├─ ipc.ts                # 全部 ipcMain.handle 注册 + chat:send 编排
│  └─ transfer.ts           # 导出/导入（文件对话框、头像 base64 编解码）
├─ preload/index.ts         # contextBridge 暴露 window.api
└─ renderer/
   ├─ index.html            # CSP（仅生产构建注入）
   └─ src/
      ├─ App.tsx            # 视图切换、TabBar、流式事件订阅、Toast/确认弹窗宿主
      ├─ store/appStore.ts + chatStore.ts
      ├─ pages/ HomePage / MinePage / CardDetailPage / CardEditorPage / ChatPage / SettingsPage
      ├─ components/ TabBar / SearchBar / CardItem / Avatar / SegmentedControl / ConfirmDialog / Modal / WorldbookEntryModal / Toast / icons
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
  systemPrompt: string
  greeting: string     // 开场白，'' = 无
  worldbook: WorldbookEntry[]
  model?: string       // 可选：该卡指定的模型；空/缺省 = 用设置里的默认模型
  stream?: boolean     // 可选：该卡指定的输出方式；缺省 = 用设置里的默认（聊天页状态条可改）
  createdAt: number; updatedAt: number
}
interface ChatMessage {
  id: string           // uuid；消息级操作（修改/删除/重发/分支）一律按它定位，不用数组下标
  role: 'user'|'assistant'
  content: string
  ts: number
  editedAt?: number    // 被改过的时间戳；无 = 没改过（界面上挂灰色「已修改」小字）
}
interface Conversation {
  id: string; cardId: string
  title: string        // 自动取首条用户消息前20字，否则"新对话"
  createdAt: number; updatedAt: number
  messages: ChatMessage[]
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
| `convs:branch` | (cardId, convId, messageId) → Conversation | 复制到这条为止建新对话（每条重新生成 id），标题 `原标题 · 分支`，写 `branchFrom`；原对话不碰 |
| `app:copy-text` | text → void | 主进程 `clipboard.writeText`（理由见 §3 消息级操作一节） |
| `chat:send` | (cardId, convId, text) → {ok} | 立即返回，流式经推送事件 |
| `chat:abort` | (cardId, convId) → void | 中止 fetch，半截文本已持久化 |
| `export:card` | cardId → {path\|null} | 保存对话框，默认名 <卡名>.json |
| `import:cards` | — → {imported} | 打开对话框多选 |

### 推送频道（main → renderer，`chat:event`）

```ts
type ChatEvent =
  | { type: 'delta';   cardId: string; convId: string; text: string }
  | { type: 'done';    cardId: string; convId: string; fullText: string }  // 已持久化
  | { type: 'error';   cardId: string; convId: string; message: string; detail?: string }
  | { type: 'aborted'; cardId: string; convId: string; partial: string }   // 已持久化
```

### preload API（window.api）

`cards.{list,save,delete,pickAvatar}`、`meta.{get,update}`、`settings.{get,save,test}`、`providers.{list,save,delete,setCurrent,fetchModels}`、`convs.{list,get,create,rename,delete,updateMessage,deleteMessage,regenerate,branch}`、`chat.{send,abort,onEvent(cb)→unsubscribe}`、`copyText(text)`、`io.{exportCard,importCards}`。

聊天数据流：渲染层 `chat.send()` 拿到 `{ok}` 后乐观显示用户气泡，随后只消费 `chat:event` 推送；`delta` 累加进气泡，`done`/`aborted` 定稿，`error` 在气泡上方显示中文横幅（`detail` 作灰色小字）。渲染层的流式状态以事件为准，不依赖 send 的返回值。

渲染层约定：`pickAvatar` 返回的文件名只存编辑器内存，「保存」才写进卡片；「移除头像」同理只改内存字段，保存时由主进程删旧图。

## 5. 头像管线

1. 选图 → 对话框（png/jpg/jpeg/webp/gif）→ 超 5MB 拒绝 → 原样 copyFile 到 `avatars/<cardId>.<随机后缀>.<ext>` → 返回新文件名（此时**不**改卡片记录、**不**删旧文件）
2. 编辑器只把新文件名暂存在内存；点「保存」时 cards:save 对比记录中的旧文件名，不同才删旧文件。取消编辑 → 新文件成为孤儿，下次启动自动清理
3. 显示：自定义协议 `app-media://`（注册为 privileged+standard），`protocol.handle` 内做路径穿越防护（resolve 后必须仍在 avatarDir 内），`net.fetch(pathToFileURL(...))` 返回；渲染层 `<img src="app-media://local/avatars/xxx.png">`，开发（http 源）与打包（file 源）下行为一致；文件名含随机后缀，天然免疫浏览器缓存（换图无需加时间戳）
4. 无头像：色块 + 名字首字，颜色 = 8 色调色板按 card.id 哈希取模
5. 导出：头像读为 `avatarDataUrl`（data:image/...;base64）写入 JSON；导入：解码回 avatars/ 目录，失败回退占位

## 6. 世界书注入算法（纯函数，main/worldbook.ts）

1. **扫描窗口**：最近 8 条消息 + 当前用户消息，拼接转小写
2. **匹配**：条目激活 = `alwaysOn` 或任一关键词为窗口子串（关键词 trim + 小写，空关键词忽略）
3. **排序**：激活条目按 `order` 升序（平局按标题），常驻与触发条目同一规则，按 id 去重
4. **注入**：`[世界书条目]\n# 标题\n内容...` 拼块，与系统提示词合并为**首条 system 消息**：`块 + '\n\n' + systemPrompt`；之后是完整对话历史；最后是当前用户消息
5. **`buildMessages(card, history, currentText?)`**：`currentText` **可省略**——「重新输出」是让 AI 对已有的历史重答一遍，没有新的用户输入，不该凭空追加一条 user 消息（省略时扫描窗口就只用 history）

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
  - 在 ipc.sendChat 里算好，作为显式参数传给 `requestChat(cardId, convId, provider, model, stream, temperature, maxTokens, messages, onDelta)`
  - `testConnection` 固定用非流式小请求（max_tokens:8），测的是**传进来的那条供应商自己的模型**，不受卡片设置与「接收方式」影响
- **SSE 解析**：手写（fetch + ReadableStream + TextDecoder，按 `\n\n` 分块、`data:` 行、`[DONE]` 终止、取 `choices[0].delta.content`），零依赖
- **持久化**：send 时先存用户消息（首条自动设标题、首次聊天自动收录历史），流结束后存 assistant 消息（完整或半截）
- **错误映射（中文优先）**：401→"API Key 无效或未填写"；403→"没有访问权限"；404→"接口地址或模型名称不正确"；429→"请求太频繁，请稍后再试"；400/其他→透传 API 的 error.message；网络错误→"无法连接服务器，请检查网络和接口地址"；原始技术信息放灰色小字 detail
- **退出安全**：`before-quit` 遍历活跃流，abort 并把已累计文本同步写入对话文件

## 8. 打包

- electron-builder：appId `com.aichatcards.app`、productName `AI聊天卡`、targets = NSIS(x64, 一键安装, 桌面快捷方式) + portable、`files: ['out/**']` + asar
- 图标：build/icon.png（≥256×256，builder 自动转 .ico）
- `.npmrc` 内置国内镜像（registry/electron_mirror/electron_builder_binaries_mirror → npmmirror）；备用环境变量：ELECTRON_MIRROR、ELECTRON_BUILDER_BINARIES_MIRROR
- 未签名 exe 首次运行 SmartScreen 提示，README 已说明
