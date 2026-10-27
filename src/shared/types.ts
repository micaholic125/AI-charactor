// 数据模型、IPC 契约、默认值的唯一真源（main / preload / renderer 三端共用）
// 规范见 docs/tech.md §3、§4

// ---------- 数据类型 ----------

/** 世界书条目：关键词触发或常驻的世界设定 */
export interface WorldbookEntry {
  id: string
  title: string
  content: string
  keywords: string[] // UI 按 , 和 ，拆分
  order: number // 升序，0 最高优先
  alwaysOn: boolean
}

/** 聊天卡：一个可聊天的角色/场景 */
export interface Card {
  id: string
  name: string
  avatar?: string // 头像文件名 "<cardId>.<随机后缀>.<ext>"；无 = 占位
  systemPrompt: string // 角色设定（提示词正文），'' = 无
  prePrompt: string // 前置词，'' = 无。与正文同属人设，只是分两段写；拼在正文前面，见 tech.md §6
  suffix: string // 后置词，'' = 无。非空时作为**最后一条消息**发送，见 tech.md §6
  greeting: string // 开场白，'' = 无
  worldbook: WorldbookEntry[]
  model?: string // 可选：该卡指定的模型；空/缺省 = 用设置里的默认模型
  stream?: boolean // 可选：该卡指定的输出方式（流式/非流式）；缺省 = 用设置里的默认
  // 生成参数：缺省 = 用设置里的全局值。
  // 判定一律用 typeof x === 'number'——0 是有效温度，靠真值判断会把「本卡设成 0」错当成「没设」
  temperature?: number // 0–2（聊天页「调节参数」面板可改）
  maxTokens?: number // 1–131072
  // 记忆设置（见 tech.md §9）：全部可选，缺省用 shared/memory.ts 里的默认值
  memoryEnabled?: boolean // 缺省 true
  memoryRecentCount?: number // 「记忆设定」每次带 N 条历史消息，默认 6，2–50
  memoryShortLimit?: number // 短期容量（字），默认 3000，200–20000
  memoryShortBatch?: number // 短→长的条数阈值，默认 25，3–100
  memoryLongLimit?: number // 长期容量（条），默认 20，2–100
  memoryLongBatch?: number // 长→永久的条数阈值，默认 10，2–50
  createdAt: number
  updatedAt: number
}

export type Role = 'user' | 'assistant'

export interface ChatMessage {
  /** 消息标识：修改/删除/重新输出/建分支一律按它定位，不用数组下标（删一条下标就全前移了） */
  id: string
  role: Role
  content: string
  ts: number
  /** 被改过的时间戳；无 = 没改过（界面上挂一行灰色的「已修改」） */
  editedAt?: number
}

// ---------- 记忆（每个对话一份，见 docs/tech.md §9） ----------

export type MemoryLayer = 'short' | 'long' | 'permanent'

export interface MemoryEntry {
  id: string
  /** 一句话一条；硬上限 300 字（见 shared/memory.ts 的 MEMORY_ENTRY_MAX） */
  content: string
  /** ai = 回复标记；summary = 兜底总结；consolidate = 沉淀；user = 用户手写；repair = 修正 */
  source: 'ai' | 'summary' | 'consolidate' | 'user' | 'repair'
  /** 产生这条记忆的消息 id；分支时据此过滤「未来信息」。用户手写为 [] */
  sourceMessageIds: string[]
  createdAt: number
  updatedAt?: number
}

export interface ConversationMemory {
  version: 1
  /** messages[0..coveredCount) 的原文已被记忆接住，可从请求里省略 */
  coveredCount: number
  short: MemoryEntry[]
  long: MemoryEntry[]
  permanent: MemoryEntry[]
  /** 每次记忆变更 +1，用于后台任务与用户编辑的乐观并发 */
  revision: number
  lastRunAt?: number
  /** 最近一次自动整理失败的中文原因；成功后清空 */
  lastError?: string
  failCount: number
  /** 退避截止时间戳；未到点不自动重试，避免失败后每轮刷请求 */
  retryAfter?: number
}

/** 记忆页读取用：记忆本体 + 对话消息数 + 是否正在跑记忆任务 */
export interface MemoryView {
  memory: ConversationMemory
  messageCount: number
  busy: boolean
}

export type MemoryOrganizeMode = 'normal' | 'rebuild'

/** 记忆后台任务推送给渲染层的事件（channel: memory:event） */
export type MemoryEvent =
  | { type: 'updated'; cardId: string; convId: string }
  | { type: 'busy'; cardId: string; convId: string; busy: boolean }
  | { type: 'error'; cardId: string; convId: string; message: string; detail?: string }
  /** 只写记忆、没有正文时的轻提示（界面 toast 一句话） */
  | { type: 'noticed'; cardId: string; convId: string; message: string }

/** 对话：一张卡下的一个独立聊天会话 */
export interface Conversation {
  id: string
  cardId: string
  title: string // 自动取首条用户消息前20字，否则"新对话"
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** 三层记忆；缺省 = 空记忆、coveredCount 0（老对话读取时补齐，不主动改写文件） */
  memory?: ConversationMemory
  /** 由哪条对话分支出来的；无 = 不是分支。见 docs/tech.md §3 消息级操作 */
  branchFrom?: { convId: string; title: string }
}

/** 删除一条消息的三种范围 */
export type DeleteMode =
  | 'only' // 只删这一条
  | 'reply-too' // 这条 + 紧随其后那条 AI 回复（撤回用）
  | 'from-here' // 这条及之后全部

/** 对话列表摘要（不含消息内容） */
export interface ConvSummary {
  id: string
  cardId: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 由分支建出来的对话：来源是哪条（列表里显示「分支自 xxx」） */
  branchFrom?: { convId: string; title: string }
}

/** 收藏/置顶/游玩历史元数据 */
export interface MetaStore {
  favoriteIds: string[] // 我的收藏成员
  favoritePinnedIds: string[] // 收藏内置顶
  historyIds: string[] // 游玩历史（首次聊天收录顺序）
  historyPinnedIds: string[] // 历史内置顶
  lastPlayedAt: Record<string, number>
}

/** 全局设置（API 接入信息已移到 Provider，见下） */
export interface Settings {
  temperature: number // 0–2
  maxTokens: number // 1–131072
  stream: boolean // true（默认）= 流式逐字显示；false = 非流式，整段一次返回
  currentProviderId: string // 当前使用的供应商 id（= 规范化 baseUrl）；'' = 还没配过
}

/**
 * 供应商：一组 API 接入配置（接口地址 + Key + 模型名）。
 * **以规范化后的接口地址作为身份**：id = trim(baseUrl) 去掉尾部 `/`，天然去重。
 * `name` 只是给人看的名字，不参与去重与请求。
 * 规范见 docs/tech.md §3、需求见 docs/requirements.md §3.7
 */
export interface Provider {
  id: string // = normalizeUrl(baseUrl)，创建后不再变（改地址等于换了一条）
  baseUrl: string // 用户填的原始写法，展示与请求都用它
  /** 自定义名称；'' = 没起名。**只用于显示**，不参与 id / 去重 / 合并 / 请求 */
  name: string
  apiKey: string
  model: string // 这条供应商的默认模型（卡片可以单独覆盖）
  models: string[] // 拉回来的可用模型名（已过滤 + 去重 + 按字母序）；[] = 还没成功获取过
  modelsFetchedAt: number // 上次成功获取模型列表的时间戳；0 = 从没成功过
  /**
   * 挑出来的常用模型，聊天页浮层只列这几个；[] = 没挑过（照旧列全部）。
   * **绝不裁剪 `models`**：`models` 永远是服务端拉回来的全量清单（重拉整表替换），
   * 用户的挑选结果单独存，才不会被下一次「获取模型列表」冲掉。
   * 里面可以有 `models` 里没有的名字（手填的），聊天页也要显示它们。
   */
  commonModels: string[]
  createdAt: number
  updatedAt: number
}

// ---------- 聊天流事件（main → renderer 推送，channel: chat:event） ----------

export type ChatEvent =
  | { type: 'delta'; cardId: string; convId: string; text: string } // 逐块增量
  | { type: 'done'; cardId: string; convId: string; fullText: string } // 完成（已持久化）
  | { type: 'error'; cardId: string; convId: string; message: string; detail?: string } // 失败（中文消息 + 原始详情）
  | { type: 'aborted'; cardId: string; convId: string; partial: string } // 已中止（部分文本已持久化）

// ---------- IPC 频道常量 ----------

export const IPC = {
  cardsList: 'cards:list',
  cardsSave: 'cards:save',
  cardsDelete: 'cards:delete',
  avatarPick: 'avatar:pick',
  metaGet: 'meta:get',
  metaUpdate: 'meta:update',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsTest: 'settings:test',
  providersList: 'providers:list',
  providersSave: 'providers:save',
  providersDelete: 'providers:delete',
  providersSetCurrent: 'providers:set-current',
  providersFetchModels: 'providers:fetch-models',
  convsList: 'convs:list',
  convsGet: 'convs:get',
  convsCreate: 'convs:create',
  convsRename: 'convs:rename',
  convsDelete: 'convs:delete',
  convsUpdateMessage: 'convs:update-message',
  convsDeleteMessage: 'convs:delete-message',
  convsRegenerate: 'convs:regenerate',
  convsBranch: 'convs:branch',
  memoryGet: 'memory:get',
  memoryAddEntry: 'memory:add-entry',
  memoryUpdateEntry: 'memory:update-entry',
  memoryDeleteEntry: 'memory:delete-entry',
  memoryClearLayer: 'memory:clear-layer',
  memoryOrganize: 'memory:organize',
  memoryEvent: 'memory:event',
  copyText: 'app:copy-text',
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatEvent: 'chat:event',
  exportCard: 'export:card',
  importCards: 'import:cards'
} as const

// ---------- preload 暴露给渲染层的 API（window.api）----------

/** 「测试连接」的结果：失败时给出中文说明与原始技术详情 */
export interface TestResult {
  ok: boolean
  message?: string
  detail?: string
}

/** 「获取模型列表」的结果：同样不抛异常，失败时给出中文说明与原始技术详情 */
export interface FetchModelsResult {
  ok: boolean
  /** ok = true 时是整理好的模型名（已过滤、去重、按字母序） */
  models: string[]
  message?: string
  detail?: string
}

/**
 * 导入报告：`import:cards` 的返回，界面据此显示「装进来了什么 / 有什么没装进来」。
 * 规范见 docs/tech.md §3「卡片的外部格式与导入映射」。
 */
export interface ImportReport {
  fileName: string
  ok: boolean
  /** 识别出的格式：自有格式 / Dify 格式 / 认不出 */
  kind: 'own' | 'dify' | 'unknown'
  /** ok 时：新卡的 id（报告里那个「去编辑」按钮靠它跳转到编辑页） */
  cardId?: string
  cardName?: string
  /** ok 时：装进来了什么 */
  summary?: {
    /** 角色设定字数；**0 = 文件里本来就是空的**，不是本应用弄丢了 */
    promptChars: number
    prePromptChars: number
    suffixChars: number
    worldbookEntries: number
    hasGreeting: boolean
  }
  /** 灰色小字逐条列出：被挖空的正文、不认识的字段、头像下载失败… */
  warnings: string[]
  /** 失败原因（中文）；ok 时缺省 */
  error?: string
}

/** 导出文件的结构（自有格式，文件可读、可手改） */
export interface ExportedCard {
  /** 格式标识，导入时据此识别 */
  format: 'ai-chat-cards'
  version: number
  /** 卡片全部字段；这里的 id 无意义，导入时会重新分配 */
  card: Card
  /** 可选；无头像则整个字段缺省 */
  avatarDataUrl?: string
}

/** preload 实现与渲染层类型共用此接口，防止两边走样 */
export interface Api {
  cards: {
    list(): Promise<Card[]>
    save(card: Card): Promise<Card>
    delete(cardId: string): Promise<void>
    /** 选图并复制进 avatars/，返回新文件名（不改卡片记录，保存时才落库） */
    pickAvatar(cardId: string): Promise<{ avatar?: string }>
  }
  meta: {
    get(): Promise<MetaStore>
    update(patch: Partial<MetaStore>): Promise<MetaStore>
  }
  settings: {
    get(): Promise<Settings>
    save(next: Settings): Promise<Settings>
    /** 非流式小请求探测连通性，测的是传入的这条供应商；失败不抛异常，返回中文说明 + 原始详情 */
    test(provider: Provider): Promise<TestResult>
  }
  providers: {
    list(): Promise<Provider[]>
    /** id 为空 = 新建；地址撞上已有条目则合并覆盖该条。保存后自动设为「使用中」 */
    save(provider: Provider): Promise<Provider>
    /** 删除后返回新的「使用中」供应商 id（'' = 一条都不剩） */
    delete(providerId: string): Promise<{ currentProviderId: string }>
    /** 切换使用中的供应商，返回写入后的完整设置 */
    setCurrent(providerId: string): Promise<Settings>
    /**
     * 去服务商拉这条供应商的可用模型列表（`GET {接口地址}/models`）。
     * 测的是**传进来的这条**（可以还没保存）；失败不抛异常，返回中文说明 + 原始详情。
     */
    fetchModels(provider: Provider): Promise<FetchModelsResult>
  }
  convs: {
    list(cardId: string): Promise<ConvSummary[]>
    /** 读取完整对话；对话不存在（如已被删）返回 null */
    get(cardId: string, convId: string): Promise<Conversation | null>
    create(cardId: string): Promise<Conversation>
    rename(cardId: string, convId: string, title: string): Promise<Conversation>
    delete(cardId: string, convId: string): Promise<void>
    /**
     * 改一条消息的文字。`dropAfter` = 连同这条之后的一起截掉。
     * **不发起请求**——要让 AI 重新回答请用 `regenerate`。
     */
    updateMessage(
      cardId: string,
      convId: string,
      messageId: string,
      content: string,
      dropAfter: boolean
    ): Promise<Conversation>
    /** 删一条消息（三种范围见 DeleteMode） */
    deleteMessage(
      cardId: string,
      convId: string,
      messageId: string,
      mode: DeleteMode
    ): Promise<Conversation>
    /**
     * 重新输出：去掉这条（`dropAfter` 时连它之后的一起去掉）后重新请求一次；
     * `content` 有值就先改这条的文字（「改完自己发的话，让 AI 重新回答」）。
     * 立即返回，回复内容照旧经 `chat:onEvent` 推送；`insertAt` 是新回复要落的位置。
     */
    regenerate(
      cardId: string,
      convId: string,
      messageId: string,
      opts?: { dropAfter?: boolean; content?: string }
    ): Promise<{ ok: boolean; insertAt: number }>
    /**
     * 创建分支：把到这条消息为止的内容（含这条）复制成一条新对话，之后的内容不要。
     * 每条消息都会换成新 id，原对话不受任何影响。返回新建的那条对话。
     */
    branch(cardId: string, convId: string, messageId: string): Promise<Conversation>
  }
  memory: {
    /** 读取这个对话的三层记忆；老对话返回空记忆 */
    get(cardId: string, convId: string): Promise<MemoryView>
    /** 手动添加一条；空内容拒绝；单条 300 字 */
    addEntry(
      cardId: string,
      convId: string,
      layer: MemoryLayer,
      content: string
    ): Promise<ConversationMemory>
    /** 手动修改一条 */
    updateEntry(
      cardId: string,
      convId: string,
      layer: MemoryLayer,
      entryId: string,
      content: string
    ): Promise<ConversationMemory>
    /** 手动删除一条 */
    deleteEntry(
      cardId: string,
      convId: string,
      layer: MemoryLayer,
      entryId: string
    ): Promise<ConversationMemory>
    /** 清空一层；不改变 coveredCount */
    clearLayer(
      cardId: string,
      convId: string,
      layer: MemoryLayer
    ): Promise<ConversationMemory>
    /**
     * 手动整理：立即在后台跑一次兜底总结。`rebuild` 会先清空三层与水位再从头整理。
     * 立即返回，进度经 `memory:onEvent` 推送。
     */
    organize(
      cardId: string,
      convId: string,
      mode?: MemoryOrganizeMode
    ): Promise<{ ok: boolean }>
    /** 订阅记忆后台任务事件，返回取消订阅函数 */
    onEvent(cb: (ev: MemoryEvent) => void): () => void
  }
  chat: {
    /** 立即返回，回复内容经 chat:onEvent 推送 */
    send(cardId: string, convId: string, text: string): Promise<{ ok: boolean }>
    abort(cardId: string, convId: string): Promise<void>
    /** 订阅流式事件，返回取消订阅函数 */
    onEvent(cb: (ev: ChatEvent) => void): () => void
  }
  io: {
    /** 导出这张卡：弹保存对话框。用户取消时 `path` 为 null */
    exportCard(cardId: string): Promise<{ path: string | null }>
    /**
     * 导入：弹文件对话框（**可多选**），逐个识别格式并转换落盘，
     * **一张失败不影响其余**。**不抛异常**——失败写在报告的 `error` 里。
     */
    importCards(): Promise<ImportReport[]>
  }
  /** 复制到系统剪贴板。走主进程而不是 navigator.clipboard：后者依赖文档焦点，会偶发不生效 */
  copyText(text: string): Promise<void>
}

// ---------- 默认值 ----------

export const DEFAULT_SETTINGS: Settings = {
  temperature: 0.8,
  maxTokens: 2048,
  stream: true,
  currentProviderId: ''
}

/** 供应商地址的规范形式（trim + 去尾部 /），也是 Provider.id 的算法；主进程与界面共用 */
export function normalizeProviderUrl(baseUrl: string): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '')
}

/** 供应商在界面上的显示名：起过名就用名称，没起名就用接口地址。规范见 docs/design.md §4 */
export function providerLabel(provider: Pick<Provider, 'name' | 'baseUrl'>): string {
  const name = (provider?.name ?? '').trim()
  return name !== '' ? name : (provider?.baseUrl ?? '')
}

/** 首次运行 / 旧数据迁移时用的供应商种子（用户只需补一个 API Key） */
export const DEFAULT_PROVIDER_BASE_URL = 'https://api.deepseek.com/v1'
export const DEFAULT_PROVIDER_MODEL = 'deepseek-chat'

/**
 * 兜底模型清单：只在「这条供应商还没获取过模型列表」时用，免得下拉是空的。
 * 真正的模型列表应当由「获取模型列表」从服务商那里拉回来（见 docs/tech.md §3）。
 */
export const FALLBACK_MODELS = [
  'deepseek-chat',
  'deepseek-reasoner',
  'moonshot-v1-8k',
  'glm-4-plus',
  'qwen-plus',
  'gpt-4o-mini'
]

export const DEFAULT_META: MetaStore = {
  favoriteIds: [],
  favoritePinnedIds: [],
  historyIds: [],
  historyPinnedIds: [],
  lastPlayedAt: {}
}

// ---------- 示例卡工厂（首次运行种子数据，帮助新手理解机制） ----------

export function createSampleCard(): Card {
  const now = Date.now()
  return {
    id: 'sample-card',
    name: '示例：暖心助手小暖',
    systemPrompt:
      '你是小暖，一个温柔耐心的生活助手。你说话亲切自然，总是先倾听再回应。\n' +
      '不要暴露自己是 AI；不要说"作为 AI 模型"之类的话。',
    prePrompt: '',
    suffix: '',
    greeting: '你好呀，我是小暖！今天想聊点什么？',
    worldbook: [
      {
        id: 'sample-wb-1',
        title: '雨天场景',
        content: '对话中提到雨时，场景自动切换为雨天：窗外细雨绵绵，空气里弥漫着潮湿的气息。',
        keywords: ['下雨', '雨天', '雨'],
        order: 0,
        alwaysOn: false
      },
      {
        id: 'sample-wb-2',
        title: '基础世界观',
        content: '故事发生在现代都市。小暖住在市中心一间温馨的小公寓里，喜欢读书和烘焙。',
        keywords: [],
        order: 1,
        alwaysOn: true
      }
    ],
    createdAt: now,
    updatedAt: now
  }
}
