// JSON 持久化层：userData 路径、原子写、内存缓存、种子数据、CRUD
// 规范见 docs/tech.md §3。所有写操作走「临时文件 + 重命名」原子写，每文件一条写队列。

import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { randomBytes, randomUUID } from 'crypto'
import type {
  Card,
  ChatMessage,
  ConvSummary,
  Conversation,
  DeleteMode,
  MetaStore,
  Settings
} from '@shared/types'
import { DEFAULT_META, DEFAULT_SETTINGS, createSampleCard } from '@shared/types'

// ---------- 路径 ----------

let dataDir = ''
let conversationsDir = ''
let avatarsDir = ''

/**
 * 初始化存储路径。必须在 app ready 之前调用：
 * 显式把 userData 重定向到 %APPDATA%\ai-chat-cards，保证纯 ASCII 路径。
 */
export function initStore(): void {
  const userDataDir = join(app.getPath('appData'), 'ai-chat-cards')
  app.setPath('userData', userDataDir)
  dataDir = join(userDataDir, 'data')
  conversationsDir = join(userDataDir, 'conversations')
  avatarsDir = join(userDataDir, 'avatars')
}

export function getAvatarsDir(): string {
  return avatarsDir
}

const cardsFile = (): string => join(dataDir, 'cards.json')
const metaFile = (): string => join(dataDir, 'meta.json')
const settingsFile = (): string => join(dataDir, 'settings.json')
const convFile = (cardId: string, convId: string): string =>
  join(conversationsDir, cardId, `${convId}.json`)

/** 供应商配置文件的路径（providers.ts 用，保持「一个模块管一类数据文件」） */
export const providersFilePath = (): string => join(dataDir, 'providers.json')

// ---------- 原子写 ----------

const writeQueues = new Map<string, Promise<void>>()

async function doWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(tmp, data, 'utf8')
  await fs.rename(tmp, file)
}

/** 排队原子写：同一文件串行执行，队列本身永不拒绝 */
export function enqueueWrite(file: string, data: string): Promise<void> {
  const prev = writeQueues.get(file) ?? Promise.resolve()
  const task = prev.then(() => doWrite(file, data))
  writeQueues.set(file, task.catch(() => {}))
  return task
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T
}

/**
 * 读取 settings.json 的**原始内容**（不做字段清洗）。
 * 只给旧数据迁移用：新版本已经不需要 baseUrl/apiKey/model 了，
 * 但老用户升级上来时要从这里把它们的配置捞出来变成第一条供应商。
 */
export async function readRawSettings(): Promise<Record<string, unknown>> {
  try {
    return await readJson<Record<string, unknown>>(settingsFile())
  } catch {
    return {}
  }
}

/** 只要设置里这几项，其余（含旧版本残留的 baseUrl/apiKey/model/providerKeys）一律丢弃 */
function pickSettings(raw: Partial<Settings>): Settings {
  const temperature = Number(raw.temperature)
  const maxTokens = Math.floor(Number(raw.maxTokens))
  return {
    temperature: Number.isFinite(temperature) && temperature >= 0 && temperature <= 2
      ? temperature
      : DEFAULT_SETTINGS.temperature,
    maxTokens: Number.isFinite(maxTokens) && maxTokens >= 1 ? maxTokens : DEFAULT_SETTINGS.maxTokens,
    // 只有显式 false 才是非流式；缺省/垃圾值一律按流式（旧数据没有这个字段）
    stream: raw.stream !== false,
    currentProviderId:
      typeof raw.currentProviderId === 'string' ? raw.currentProviderId.trim() : ''
  }
}

// ---------- 内存缓存 ----------

let cards: Card[] = []
let meta: MetaStore = { ...DEFAULT_META }
let settings: Settings = { ...DEFAULT_SETTINGS }
/** 已加载的对话缓存：cardId -> convId -> Conversation */
const convCache = new Map<string, Map<string, Conversation>>()

// ---------- 初始化与种子数据 ----------

/**
 * 创建目录、读取数据文件；文件不存在时写入种子数据。
 * 卡片文件损坏时先备份为 .bak 再重建示例卡，避免用户数据直接丢失。
 */
export async function ensureStore(): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  await fs.mkdir(conversationsDir, { recursive: true })
  await fs.mkdir(avatarsDir, { recursive: true })

  try {
    cards = await readJson<Card[]>(cardsFile())
    // 旧数据兼容：老卡片没有 suffix / prePrompt 字段 → 读时补齐为 ''。
    // 沿用「读时补齐、下次写才落盘」，不主动改写用户文件
    cards = cards.map((c) => ({ ...c, suffix: c.suffix ?? '', prePrompt: c.prePrompt ?? '' }))
  } catch {
    try {
      await fs.rename(cardsFile(), `${cardsFile()}.bak`)
    } catch {
      /* 文件不存在则忽略 */
    }
    cards = [createSampleCard()]
    await enqueueWrite(cardsFile(), JSON.stringify(cards, null, 2))
  }

  try {
    meta = { ...DEFAULT_META, ...(await readJson<MetaStore>(metaFile())) }
  } catch {
    await enqueueWrite(metaFile(), JSON.stringify(meta, null, 2))
  }

  try {
    settings = pickSettings(await readJson<Partial<Settings>>(settingsFile()))
  } catch {
    settings = { ...DEFAULT_SETTINGS }
    await enqueueWrite(settingsFile(), JSON.stringify(settings, null, 2))
  }

  // 清理没有任何卡片引用的头像文件（编辑器里选图后取消会留下孤儿）
  await sweepOrphanAvatars()
}

// ---------- 卡片 CRUD ----------

export function getCards(): Card[] {
  return [...cards].sort((a, b) => b.createdAt - a.createdAt)
}

export function getCard(id: string): Card | undefined {
  return cards.find((c) => c.id === id)
}

function persistCards(): Promise<void> {
  return enqueueWrite(cardsFile(), JSON.stringify(cards, null, 2))
}

/**
 * 卡片级生成参数：只收合法值，**越界与垃圾一律当「没设」**（回落到全局设置），不报错。
 * 判定必须用 `typeof x === 'number'`——`0` 是有效温度，靠真值判断会把「本卡设成 0」错当成「没设」。
 * 范围与 settings:save 的校验保持一致（见 ipc.ts 的 validateSettings）。
 */
function pickCardTemperature(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2 ? v : undefined
}

function pickCardMaxTokens(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.floor(v)
  return n >= 1 && n <= 131072 ? n : undefined
}

/** 新建（无 id 时分配 uuid）或更新卡片 */
export async function saveCard(input: Card): Promise<Card> {
  const now = Date.now()
  const idx = cards.findIndex((c) => c.id === input.id)
  const next: Card = {
    ...input,
    id: input.id || randomUUID(),
    // 头像字段只接受纯文件名（防路径穿越），非法值一律当无头像
    avatar: input.avatar && isSafeAvatarName(input.avatar) ? input.avatar : undefined,
    worldbook: input.worldbook ?? [],
    // 前置词：'' = 无（发请求时不拼进首条 system）
    prePrompt: (input.prePrompt ?? '').trim(),
    // 后置词：'' = 无（发请求时不追加任何消息）
    suffix: (input.suffix ?? '').trim(),
    // 模型：空串一律存成缺省（发请求时回退到设置里的默认模型）
    model: (input.model ?? '').trim() || undefined,
    // 输出方式：只有真正的布尔才存（缺省 = 跟随设置）
    stream: typeof input.stream === 'boolean' ? input.stream : undefined,
    // 生成参数：缺省 = 跟随设置（归一在校验里做一处，请求时直接用，不再兜底）
    temperature: pickCardTemperature(input.temperature),
    maxTokens: pickCardMaxTokens(input.maxTokens),
    createdAt: idx >= 0 ? cards[idx].createdAt : now,
    updatedAt: now
  }

  const prevAvatar = idx >= 0 ? cards[idx].avatar : undefined
  if (idx >= 0) cards[idx] = next
  else cards.unshift(next)
  await persistCards()

  // 头像换过（或移除）才删旧文件
  if (prevAvatar && prevAvatar !== next.avatar) await deleteAvatarFile(prevAvatar)
  return next
}

/** 删除卡片：连带删除其全部对话目录、头像文件，并清理收藏/历史中的引用 */
export async function deleteCard(id: string): Promise<void> {
  cards = cards.filter((c) => c.id !== id)
  await persistCards()

  await fs.rm(join(conversationsDir, id), { recursive: true, force: true })
  convCache.delete(id)
  await removeAvatarFiles(id)

  meta = {
    ...meta,
    favoriteIds: meta.favoriteIds.filter((x) => x !== id),
    favoritePinnedIds: meta.favoritePinnedIds.filter((x) => x !== id),
    historyIds: meta.historyIds.filter((x) => x !== id),
    historyPinnedIds: meta.historyPinnedIds.filter((x) => x !== id)
  }
  const { [id]: _removed, ...rest } = meta.lastPlayedAt
  meta.lastPlayedAt = rest
  await persistMeta()
}

// ---------- 头像文件 ----------

/** 头像文件名必须是不含路径分隔符的纯文件名（防导出文件里夹带路径穿越） */
export function isSafeAvatarName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes('..')
}

/** 删除单个头像文件（不存在则静默忽略） */
export async function deleteAvatarFile(name: string): Promise<void> {
  if (!isSafeAvatarName(name)) return
  await fs.unlink(join(avatarsDir, name)).catch(() => {})
}

/**
 * 把选中的图片复制成新的头像文件，返回文件名；**不改卡片记录、不删旧图**。
 * 文件名带随机后缀：编辑器里换了图又取消，也不会影响已保存卡片的头像。
 */
export async function copyAvatarFile(cardId: string, srcPath: string, ext: string): Promise<string> {
  const name = `${cardId}.${randomBytes(4).toString('hex')}.${ext}`
  await fs.copyFile(srcPath, join(avatarsDir, name))
  return name
}

/** 把一段二进制写成这张卡的头像（导入时用：base64 解码、或下载来的外部图标） */
export async function writeAvatarFile(
  cardId: string,
  data: Uint8Array,
  ext: string
): Promise<string> {
  const name = `${cardId}.${randomBytes(4).toString('hex')}.${ext}`
  await fs.writeFile(join(avatarsDir, name), data)
  return name
}

/** 删除 avatars/ 下该卡片的全部头像文件（扩展名不限），用于删除卡片 */
export async function removeAvatarFiles(cardId: string): Promise<void> {
  const files = await fs.readdir(avatarsDir).catch(() => [] as string[])
  await Promise.all(
    files
      .filter((f) => f.startsWith(`${cardId}.`))
      .map((f) => fs.unlink(join(avatarsDir, f)).catch(() => {}))
  )
}

/** 启动清理：删除没有任何卡片引用的头像文件 */
export async function sweepOrphanAvatars(): Promise<void> {
  const used = new Set(cards.map((c) => c.avatar).filter((a): a is string => !!a))
  const files = await fs.readdir(avatarsDir).catch(() => [] as string[])
  await Promise.all(
    files.filter((f) => !used.has(f)).map((f) => fs.unlink(join(avatarsDir, f)).catch(() => {}))
  )
}

// ---------- 元数据 ----------

export function getMeta(): MetaStore {
  return meta
}

function persistMeta(): Promise<void> {
  return enqueueWrite(metaFile(), JSON.stringify(meta, null, 2))
}

/** 更新元数据（渲染层只传变更的数组键） */
export async function updateMeta(patch: Partial<MetaStore>): Promise<MetaStore> {
  meta = { ...meta, ...patch }
  await persistMeta()
  return meta
}

// ---------- 设置 ----------

export function getSettings(): Settings {
  return settings
}

export async function saveSettings(next: Settings): Promise<Settings> {
  settings = next
  await enqueueWrite(settingsFile(), JSON.stringify(settings, null, 2))
  return settings
}

// ---------- 对话 ----------

/**
 * 老数据兼容：早期的消息没有 id，补一个**确定性**的（主进程和渲染层各自算一遍必须一致，
 * 否则消息级操作会找不到目标）。只在内存里补，不主动改写用户的文件——
 * 下次这条对话因为别的原因被保存时，id 自然写进文件。见 docs/tech.md §3。
 */
function ensureMessageIds(conv: Conversation): Conversation {
  let touched = false
  const messages = (conv.messages ?? []).map((m, i) => {
    if (typeof m?.id === 'string' && m.id !== '') return m
    touched = true
    return { ...m, id: `legacy-${i}-${m?.ts ?? 0}` }
  })
  return touched ? { ...conv, messages } : conv
}

/** 加载某卡片的全部对话进缓存（只读一次目录） */
async function loadCardConvs(cardId: string): Promise<Map<string, Conversation>> {
  const cached = convCache.get(cardId)
  if (cached) return cached
  const map = new Map<string, Conversation>()
  const dir = join(conversationsDir, cardId)
  const files = await fs.readdir(dir).catch(() => [] as string[])
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const conv = ensureMessageIds(await readJson<Conversation>(join(dir, f)))
      map.set(conv.id, conv)
    } catch {
      /* 损坏的对话文件跳过（不阻塞其余） */
    }
  }
  convCache.set(cardId, map)
  return map
}

export async function listConversations(cardId: string): Promise<ConvSummary[]> {
  const map = await loadCardConvs(cardId)
  return [...map.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({
      id: c.id,
      cardId: c.cardId,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      ...(c.branchFrom === undefined ? {} : { branchFrom: c.branchFrom })
    }))
}

export async function getConversation(cardId: string, convId: string): Promise<Conversation | undefined> {
  const map = await loadCardConvs(cardId)
  return map.get(convId)
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const map = await loadCardConvs(conv.cardId)
  map.set(conv.id, conv)
  await enqueueWrite(convFile(conv.cardId, conv.id), JSON.stringify(conv, null, 2))
}

/** 新建对话：若卡片有开场白则作为首条 assistant 消息 */
export async function createConversation(card: Card): Promise<Conversation> {
  const now = Date.now()
  const conv: Conversation = {
    id: randomUUID(),
    cardId: card.id,
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    messages:
      card.greeting.trim() !== ''
        ? [{ id: randomUUID(), role: 'assistant', content: card.greeting, ts: now }]
        : []
  }
  await saveConversation(conv)
  return conv
}

/** 对话标题上限 30 字，超出截断加省略号 */
function capTitle(title: string): string {
  return title.length > 30 ? `${title.slice(0, 30)}…` : title
}

/** 重命名对话（上限 30 字，超出截断加省略号） */
export async function renameConversation(
  cardId: string,
  convId: string,
  title: string
): Promise<Conversation> {
  const conv = await getConversation(cardId, convId)
  if (!conv) throw new Error('对话不存在')
  const next = (title ?? '').trim().replace(/\s+/g, ' ')
  if (next === '') throw new Error('对话名称不能为空')
  conv.title = capTitle(next)
  conv.updatedAt = Date.now()
  await saveConversation(conv)
  return conv
}

export async function deleteConversation(cardId: string, convId: string): Promise<void> {
  const map = await loadCardConvs(cardId)
  map.delete(convId)
  await fs.unlink(convFile(cardId, convId)).catch(() => {})
}

// ---------- 消息级操作（改内容 / 删除）----------

/** 按 id 定位一条消息，返回它在数组里的位置 */
function findMessage(conv: Conversation, messageId: string): number {
  const idx = conv.messages.findIndex((m) => m.id === messageId)
  if (idx < 0) throw new Error('这条消息已经不在了，请重开对话看看')
  return idx
}

/** 改一条消息的文字（不发起请求）；`dropAfter` = 连同这条之后的一起截掉 */
export async function updateMessage(
  cardId: string,
  convId: string,
  messageId: string,
  content: string,
  dropAfter: boolean
): Promise<Conversation> {
  const conv = await getConversation(cardId, convId)
  if (!conv) throw new Error('对话不存在')
  const text = (content ?? '').trim()
  if (text === '') throw new Error('内容不能为空')

  const idx = findMessage(conv, messageId)
  conv.messages[idx] = { ...conv.messages[idx], content: text, editedAt: Date.now() }
  if (dropAfter) conv.messages = conv.messages.slice(0, idx + 1)
  conv.updatedAt = Date.now()
  await saveConversation(conv)
  return conv
}

/**
 * 「重新输出」的前置改写：把要重发的那条清掉（`dropAfter` 时连它之后的一起清掉），
 * 可选先把 `content` 写进这条（用于「改完自己发的话，让 AI 重新回答」）。
 * **不发起请求**——请求由 ipc.ts 编排。
 *
 * 返回重发要用的历史，以及新回复该落回哪个位置。两种目标不一样：
 * - 目标是 **AI 回复**：把它替换掉，`insertAt` = 它的下标（`dropAfter: true` 时正好追加到末尾）
 * - 目标是 **用户的话**：它自己得留着（要重答的就是它），替换掉的是紧随的那条 AI 回复，
 *   `insertAt` = 它的下标 + 1
 * 见 docs/tech.md §3。
 */
export async function prepareRegenerate(
  cardId: string,
  convId: string,
  messageId: string,
  content: string | undefined,
  dropAfter: boolean
): Promise<{ history: ChatMessage[]; insertAt: number }> {
  const conv = await getConversation(cardId, convId)
  if (!conv) throw new Error('对话不存在')

  const idx = findMessage(conv, messageId)
  const target = conv.messages[idx]
  // 开场白前面什么都没有，没东西可重发
  if (idx === 0 && target.role === 'assistant') {
    throw new Error('这是对话的开头，没有可以重新回答的内容')
  }

  const text = (content ?? '').trim()
  if (text !== '') {
    conv.messages[idx] = { ...target, content: text, editedAt: Date.now() }
  }

  // 历史到这条为止（用户的话自己也算，AI 回复不算——它要被换掉）
  const keep = target.role === 'user' ? idx + 1 : idx
  const history = conv.messages.slice(0, keep)
  // 这条本身要被替换掉；目标是用户的话时，紧随其后那条旧回复也要一起清掉，
  // 否则新回复插进去会把它顶成一条多余的话
  const skip = target.role === 'user' && conv.messages[idx + 1]?.role === 'assistant' ? 1 : 0
  const rest = conv.messages.slice(idx + 1 + skip)
  conv.messages = dropAfter ? history.slice() : [...history, ...rest]

  conv.updatedAt = Date.now()
  await saveConversation(conv)
  return { history, insertAt: keep }
}

/** 删一条消息：只删这条 / 这条 + 紧随的那条 AI 回复（撤回）/ 这条及之后全部 */
export async function deleteMessage(
  cardId: string,
  convId: string,
  messageId: string,
  mode: DeleteMode
): Promise<Conversation> {
  const conv = await getConversation(cardId, convId)
  if (!conv) throw new Error('对话不存在')

  const idx = findMessage(conv, messageId)
  if (mode === 'from-here') {
    conv.messages = conv.messages.slice(0, idx)
  } else if (mode === 'reply-too') {
    // 「撤回」：自己发的话连同它引出的那条 AI 回复一起删（后面不是 AI 回复就只删这条）
    const next = conv.messages[idx + 1]
    conv.messages.splice(idx, next?.role === 'assistant' ? 2 : 1)
  } else {
    conv.messages.splice(idx, 1)
  }

  conv.updatedAt = Date.now()
  await saveConversation(conv)
  return conv
}

/**
 * 从某条消息分叉：把到这条为止的内容复制成一条新对话（含这条），之后的不要。
 * **每条消息都换新 id**——两边从此各改各的，共用 id 会让「按 id 定位」互相串台。
 * 原对话一个字都不动（只读它，不写回）。见 docs/tech.md §3。
 */
export async function branchConversation(
  cardId: string,
  convId: string,
  messageId: string
): Promise<Conversation> {
  const src = await getConversation(cardId, convId)
  if (!src) throw new Error('对话不存在')

  const idx = findMessage(src, messageId)
  const now = Date.now()
  const conv: Conversation = {
    id: randomUUID(),
    cardId,
    title: capTitle(`${src.title} · 分支`),
    createdAt: now,
    updatedAt: now,
    branchFrom: { convId: src.id, title: src.title },
    messages: src.messages.slice(0, idx + 1).map((m) => ({
      id: randomUUID(),
      role: m.role,
      content: m.content,
      ts: m.ts,
      ...(m.editedAt === undefined ? {} : { editedAt: m.editedAt })
    }))
  }
  await saveConversation(conv)
  return conv
}
