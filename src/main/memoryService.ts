// 记忆后台任务：兜底总结、向上沉淀、coveredCount 推进、任务锁、退避、记忆事件。
// 与聊天完全隔离：用 chatClient.requestCompletion，不占 cardId:convId 的流式锁。
// 规范见 docs/tech.md §9.4–§9.7。

import { randomUUID } from 'crypto'
import type {
  ChatMessage,
  ConversationMemory,
  MemoryEntry,
  MemoryEvent,
  Provider
} from '@shared/types'
import {
  emptyMemory,
  memoryChars,
  memoryEntryKey,
  normalizeMemory,
  normalizeMemoryContent,
  resolveMemoryConfig
} from '@shared/memory'
import {
  getCard,
  getConversation,
  saveConversation,
  withConvLock
} from './store'
import { getCurrentProvider } from './providers'
import { ChatError, requestCompletion } from './chatClient'
import {
  buildConsolidationMessages,
  buildRefreshMessages,
  buildSummaryMessages,
  dedupeEntryTexts,
  extractConsolidationText,
  extractEntryStrings,
  parseJsonLoose,
  parseRefreshResult,
  type ConsolidationTarget,
  type RefreshLayers
} from './memory'

/** 一轮任务里每步的结果：applied = 真的改了记忆；none = 没触发/放弃；error = 失败（已记退避） */
type StepResult = 'applied' | 'none' | 'error'

const MAX_STEPS = 3
const CHUNK_MAX_MESSAGES = 30
const CHUNK_MAX_CHARS = 6000
const REFRESH_AROUND = 10
const REFRESH_RECENT = 20
const REFRESH_MAX_CHARS = 6000
const TASK_TEMPERATURE = 0.2
const TASK_MAX_TOKENS = 4096
const BACKOFF_BASE = 60_000
const BACKOFF_MAX = 15 * 60_000

interface MemoryJob {
  controller: AbortController
  rerun: boolean
  /** 排队的「一起整理记忆」锚点；null = 没有。锚点缺失 = 不限定位置 */
  pendingRefresh: { anchor?: number } | null
  promise: Promise<void>
}

const jobs = new Map<string, MemoryJob>()
let notifier: (event: MemoryEvent) => void = () => {}

const keyOf = (cardId: string, convId: string): string => `${cardId}:${convId}`

export function setMemoryNotifier(fn: (event: MemoryEvent) => void): void {
  notifier = fn
}

function notify(event: MemoryEvent): void {
  try {
    notifier(event)
  } catch {
    /* 推送失败不影响任务本身 */
  }
}

/** 给 ipc / 聊天编排用的轻量事件出口（例如「只写入了记忆」的 toast） */
export function notifyMemoryEvent(event: MemoryEvent): void {
  notify(event)
}

export function isMemoryBusy(cardId: string, convId: string): boolean {
  return jobs.has(keyOf(cardId, convId))
}

export function pendingMemoryJobCount(): number {
  return jobs.size
}

/**
 * 安排一次记忆任务。同一对话已在跑时只置 rerun，结束后再补跑一轮，绝不并发堆请求。
 * `manual` = 用户点了「现在整理一次」：忽略退避与溢出阈值，立即整理最多 3 段。
 */
export function scheduleMemoryJobs(cardId: string, convId: string, manual = false): void {
  const existing = jobs.get(keyOf(cardId, convId))
  if (existing) {
    existing.rerun = true
    return
  }
  startJob(cardId, convId, manual, (signal) => runLoop(cardId, convId, signal, manual))
}

/**
 * 安排一次「修正记忆」（改/删/重发已覆盖消息之后）。
 * 同一对话正在跑别的记忆任务时排队，等它结束后再跑，不并发。
 */
export function scheduleMemoryRefresh(
  cardId: string,
  convId: string,
  anchor?: number
): void {
  const existing = jobs.get(keyOf(cardId, convId))
  if (existing) {
    existing.pendingRefresh = { anchor }
    return
  }
  startJob(cardId, convId, false, (signal) =>
    runRefresh(cardId, convId, anchor, signal)
  )
}

/** 建一个任务槽并跑 `run`；结束后按排队情况补跑（先修正、再兜底总结） */
function startJob(
  cardId: string,
  convId: string,
  manual: boolean,
  run: (signal: AbortSignal) => Promise<void>
): void {
  const key = keyOf(cardId, convId)
  const controller = new AbortController()
  const job: MemoryJob = {
    controller,
    rerun: false,
    pendingRefresh: null,
    promise: Promise.resolve()
  }
  jobs.set(key, job)
  notify({ type: 'busy', cardId, convId, busy: true })

  job.promise = run(controller.signal)
    .catch(() => {})
    .finally(() => {
      if (jobs.get(key) === job) jobs.delete(key)
      notify({ type: 'busy', cardId, convId, busy: false })
      if (job.pendingRefresh !== null) {
        scheduleMemoryRefresh(cardId, convId, job.pendingRefresh.anchor)
        // 修正之后还要补跑兜底总结的话，挂到新任务上
        if (job.rerun) {
          const next = jobs.get(key)
          if (next) next.rerun = true
        }
      } else if (job.rerun) {
        scheduleMemoryJobs(cardId, convId, manual)
      }
    })
}

/** 手动整理；mode = rebuild 会先清空三层与水位，再从头总结 */
export async function organizeNow(
  cardId: string,
  convId: string,
  mode: 'normal' | 'rebuild' = 'normal'
): Promise<void> {
  const card = getCard(cardId)
  const conv = await getConversation(cardId, convId)
  if (!card || !conv) throw new Error('对话不存在')
  if (!resolveMemoryConfig(card).enabled) {
    throw new Error('这张卡关闭了记忆功能，先到编辑页打开再整理')
  }

  if (mode === 'rebuild') {
    // 先中止并等待正在跑的任务，避免它的结果覆盖刚清空的记忆
    const existing = jobs.get(keyOf(cardId, convId))
    if (existing) {
      existing.rerun = false
      existing.pendingRefresh = null
      existing.controller.abort()
      await existing.promise.catch(() => {})
    }

    await withConvLock(cardId, convId, async () => {
      const latest = await getConversation(cardId, convId)
      if (!latest) return
      const previous = normalizeMemory(latest.memory)
      const memory = emptyMemory()
      memory.revision = previous.revision + 1
      latest.memory = memory
      await saveConversation(latest)
    })
    notify({ type: 'updated', cardId, convId })
  }

  scheduleMemoryJobs(cardId, convId, true)
}

/** 退出前中止全部记忆任务并等待落盘 */
export function stopAllMemoryJobs(): Promise<void> {
  const pending = [...jobs.values()]
  for (const job of pending) {
    job.rerun = false
    job.controller.abort()
  }
  return Promise.allSettled(pending.map((job) => job.promise)).then(() => undefined)
}

// ---------- 任务循环 ----------

async function runLoop(
  cardId: string,
  convId: string,
  signal: AbortSignal,
  manual: boolean
): Promise<void> {
  const card = getCard(cardId)
  const conv = await getConversation(cardId, convId)
  if (!card || !conv) return

  const config = resolveMemoryConfig(card)
  if (!config.enabled) return

  const memory = normalizeMemory(conv.memory)
  if (!manual && memory.retryAfter !== undefined && memory.retryAfter > Date.now()) {
    return
  }

  // 第 1 步：兜底总结（最多 3 段）；失败就整轮停下，交给退避
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) return
    const result = await runOneStep(cardId, convId, signal, manual)
    if (result === 'error') return
    if (result === 'none') break
  }

  // 第 2、3 步：向上沉淀。每层一轮最多一次——整理完仍超限也等下一轮，
  // 避免一次聊天里连发好几个沉淀请求（见 docs/tech.md §9.5「通用规则」）
  if (signal.aborted) return
  if ((await consolidate(cardId, convId, 'long', signal)) === 'error') return
  if (signal.aborted) return
  await consolidate(cardId, convId, 'permanent', signal)
}

async function runOneStep(
  cardId: string,
  convId: string,
  signal: AbortSignal,
  manual: boolean
): Promise<StepResult> {
  const card = getCard(cardId)
  const conv = await getConversation(cardId, convId)
  if (!card || !conv) return 'none'

  const config = resolveMemoryConfig(card)
  if (!config.enabled) return 'none'

  const memory = normalizeMemory(conv.memory)

  const len = conv.messages.length
  const covered = Math.max(0, Math.min(memory.coveredCount, len))

  // 自动：只有「掉出最近 N 条且未覆盖」的消息够多才总结；手动：有未覆盖消息就做
  const overflow = len - config.recentCount - covered
  if (!manual && overflow < Math.max(config.recentCount, 4)) return 'none'

  const start = covered
  const end = manual
    ? Math.min(len, start + CHUNK_MAX_MESSAGES)
    : Math.min(len - config.recentCount, start + CHUNK_MAX_MESSAGES)
  if (end <= start) return 'none'

  // 再按字数截一段，至少 1 条
  let chunkEnd = start
  let chars = 0
  for (let i = start; i < end; i++) {
    const size = conv.messages[i]?.content?.length ?? 0
    if (chunkEnd > start && chars + size > CHUNK_MAX_CHARS) break
    chars += size
    chunkEnd = i + 1
  }
  const chunk = conv.messages.slice(start, chunkEnd)
  if (chunk.length === 0) return 'none'

  try {
    let provider: Provider | undefined
    try {
      provider = getCurrentProvider()
    } catch {
      provider = undefined
    }
    if (!provider) throw new ChatError('还没有配置供应商，请到「API 配置」里添加一个')
    const model = (card.model ?? '').trim() || provider.model
    if (model.trim() === '') throw new ChatError('请先填写模型名称')

    const raw = await requestCompletion(
      provider,
      { temperature: TASK_TEMPERATURE, maxTokens: TASK_MAX_TOKENS },
      model,
      buildSummaryMessages(card.name, chunk, memory.short),
      signal
    )

    const parsed = parseJsonLoose(raw)
    const validShape =
      Array.isArray(parsed) ||
      (parsed !== null &&
        typeof parsed === 'object' &&
        Object.prototype.hasOwnProperty.call(parsed, 'entries'))
    if (!validShape) {
      throw new ChatError('记忆整理返回的格式不正确', raw.trim().slice(0, 300))
    }

    const entries = extractEntryStrings(raw)
    const applied = await applySummary(cardId, convId, chunk, entries)
    if (applied) notify({ type: 'updated', cardId, convId })
    return applied ? 'applied' : 'none'
  } catch (err) {
    if (signal.aborted) return 'none'
    const mapped =
      err instanceof ChatError
        ? err
        : new ChatError(err instanceof Error ? err.message : String(err))
    await recordFailure(cardId, convId, mapped)
    notify({
      type: 'error',
      cardId,
      convId,
      message: mapped.message,
      detail: mapped.detail
    })
    return 'error'
  }
}

/**
 * 应用总结结果（乐观并发）：
 * - 校验这段消息还在、没被改过
 * - 条目去重后追加到短期
 * - coveredCount 推进到这段末尾
 * 永远不因为「AI 写了标记」推进水位——只有这条兜底总结能推进。
 */
async function applySummary(
  cardId: string,
  convId: string,
  chunk: ChatMessage[],
  entries: string[]
): Promise<boolean> {
  const snapshot = chunk.map((m) => ({ id: m.id, editedAt: m.editedAt }))

  return withConvLock(cardId, convId, async () => {
    const latest = await getConversation(cardId, convId)
    if (!latest) return false

    for (const item of snapshot) {
      const now = latest.messages.find((m) => m.id === item.id)
      if (!now || now.editedAt !== item.editedAt) {
        throw new ChatError('对话在整理期间被修改，稍后会自动重试')
      }
    }

    const memory = normalizeMemory(latest.memory)

    // 这段必须是「从水位开始的连续一段」：中间插入/删除过就放弃，避免把没总结的原文盖过去
    let expected = Math.max(0, Math.min(memory.coveredCount, latest.messages.length))
    for (const item of snapshot) {
      if (latest.messages[expected]?.id !== item.id) {
        throw new ChatError('对话在整理期间被修改，稍后会自动重试')
      }
      expected += 1
    }

    // 与三层都去重：已经沉淀进长期/永久的事实不要再写回短期
    const fresh = dedupeEntryTexts(
      [...memory.short, ...memory.long, ...memory.permanent],
      entries
    )
    const now = Date.now()

    if (fresh.length > 0) {
      const sourceMessageIds = snapshot.map((m) => m.id)
      memory.short.push(
        ...fresh.map((text) => ({
          id: randomUUID(),
          content: text,
          source: 'summary' as const,
          sourceMessageIds,
          createdAt: now,
          updatedAt: now
        }))
      )
    }

    memory.coveredCount = expected
    memory.revision += 1
    memory.lastRunAt = now
    memory.failCount = 0
    memory.lastError = undefined
    memory.retryAfter = undefined
    latest.memory = memory
    await saveConversation(latest)
    return true
  })
}

// ---------- 向上沉淀（短→长、长→永久，见 docs/tech.md §9.5） ----------

/** 该不该沉淀：条数先到，或（短期）字数超限；长期另有条数安全网 */
function needsConsolidation(
  target: ConsolidationTarget,
  entries: MemoryEntry[],
  config: ReturnType<typeof resolveMemoryConfig>
): boolean {
  // 只有 1 条时没有可合并的，硬要请求只会白花钱
  if (entries.length < 2) return false
  if (target === 'long') {
    return entries.length >= config.shortBatch || memoryChars(entries) > config.shortLimit
  }
  return entries.length >= config.longBatch || entries.length > config.longLimit
}

/**
 * 沉淀一层：取最早的若干条 → AI 合成 1 条坐到上一层。
 * 一轮最多调用一次；失败沿用同一套退避与中文原因。
 */
async function consolidate(
  cardId: string,
  convId: string,
  target: ConsolidationTarget,
  signal: AbortSignal
): Promise<StepResult> {
  const card = getCard(cardId)
  const conv = await getConversation(cardId, convId)
  if (!card || !conv) return 'none'

  const config = resolveMemoryConfig(card)
  if (!config.enabled) return 'none'

  const sourceLayer = target === 'long' ? 'short' : 'long'
  const memory = normalizeMemory(conv.memory)
  const source = memory[sourceLayer]
  if (!needsConsolidation(target, source, config)) return 'none'

  const batchSize = target === 'long' ? config.shortBatch : config.longBatch
  const batch = source.slice(0, Math.min(batchSize, source.length))
  if (batch.length < 2) return 'none'

  // 覆盖型操作：请求前记下水印，应用时对不上就放弃（用户中途改过记忆）
  const revision = memory.revision
  const ids = batch.map((entry) => entry.id)

  try {
    let provider: Provider | undefined
    try {
      provider = getCurrentProvider()
    } catch {
      provider = undefined
    }
    if (!provider) throw new ChatError('还没有配置供应商，请到「API 配置」里添加一个')
    const model = (card.model ?? '').trim() || provider.model
    if (model.trim() === '') throw new ChatError('请先填写模型名称')

    const raw = await requestCompletion(
      provider,
      { temperature: TASK_TEMPERATURE, maxTokens: TASK_MAX_TOKENS },
      model,
      buildConsolidationMessages(card.name, target, batch),
      signal
    )

    // 解析失败 / 输出为空都算失败：原记忆完全不变
    const text = extractConsolidationText(raw, target)
    if (text === null) {
      throw new ChatError('记忆整理返回的格式不正确', raw.trim().slice(0, 300))
    }
    if (text === '') throw new ChatError('记忆整理没有返回可用的内容', raw.trim().slice(0, 300))

    const applied = await applyConsolidation(cardId, convId, target, revision, ids, text)
    if (applied) notify({ type: 'updated', cardId, convId })
    return applied ? 'applied' : 'none'
  } catch (err) {
    if (signal.aborted) return 'none'
    const mapped =
      err instanceof ChatError
        ? err
        : new ChatError(err instanceof Error ? err.message : String(err))
    await recordFailure(cardId, convId, mapped)
    notify({
      type: 'error',
      cardId,
      convId,
      message: mapped.message,
      detail: mapped.detail
    })
    return 'error'
  }
}

/**
 * 应用沉淀结果（乐观并发）：
 * - `revision` 必须与请求前一致；用户中途改过记忆就放弃，绝不覆盖
 * - 再核对这批条目原样还在最前面
 * - 删掉被合并条目，上一层追加 1 条（source: 'consolidate'，来源 id 取并集）
 */
async function applyConsolidation(
  cardId: string,
  convId: string,
  target: ConsolidationTarget,
  revision: number,
  ids: string[],
  content: string
): Promise<boolean> {
  const sourceLayer = target === 'long' ? 'short' : 'long'

  return withConvLock(cardId, convId, async () => {
    const latest = await getConversation(cardId, convId)
    if (!latest) return false

    const memory = normalizeMemory(latest.memory)
    if (memory.revision !== revision) return false

    const current = memory[sourceLayer]
    if (current.length < ids.length || ids.some((id, index) => current[index]?.id !== id)) {
      return false
    }

    const batch = current.slice(0, ids.length)
    const mergedIds = new Set(ids)
    const sourceMessageIds = [...new Set(batch.flatMap((entry) => entry.sourceMessageIds))]
    const now = Date.now()

    memory[sourceLayer] = current.filter((entry) => !mergedIds.has(entry.id))
    memory[target].push({
      id: randomUUID(),
      content,
      source: 'consolidate',
      sourceMessageIds,
      createdAt: now,
      updatedAt: now
    })
    memory.revision += 1
    memory.lastRunAt = now
    memory.failCount = 0
    memory.lastError = undefined
    memory.retryAfter = undefined
    latest.memory = memory
    await saveConversation(latest)
    return true
  })
}

// ---------- 修正记忆（改/删/重发已覆盖消息之后，见 docs/tech.md §9.6） ----------

/** 取「修改点附近 ±10 条」再拼上「最近 20 条」，去重、按时间顺序、总字数不超过 6000 */
function collectRefreshMessages(messages: ChatMessage[], anchor?: number): ChatMessage[] {
  const indices = new Set<number>()
  if (anchor !== undefined) {
    const start = Math.max(0, anchor - REFRESH_AROUND)
    const end = Math.min(messages.length - 1, anchor + REFRESH_AROUND)
    for (let i = start; i <= end; i++) indices.add(i)
  }
  for (let i = Math.max(0, messages.length - REFRESH_RECENT); i < messages.length; i++) {
    indices.add(i)
  }

  const picked = [...indices].sort((a, b) => a - b).map((i) => messages[i])
  // 超长时从最新的往旧保留，避免把刚刚修改的那段挤掉
  const out: ChatMessage[] = []
  let chars = 0
  for (let i = picked.length - 1; i >= 0; i--) {
    const size = (picked[i]?.content?.length ?? 0) + 8
    if (out.length > 0 && chars + size > REFRESH_MAX_CHARS) break
    chars += size
    out.unshift(picked[i])
  }
  return out
}

/** 改写后的一层：内容没变的条目沿用原来的 id 与来源（分支过滤还靠它） */
function rebuildLayer(texts: string[], existing: MemoryEntry[], now: number): MemoryEntry[] {
  const byKey = new Map<string, MemoryEntry>()
  for (const entry of existing) {
    const key = memoryEntryKey(entry.content)
    if (key !== '') byKey.set(key, entry)
  }

  const seen = new Set<string>()
  const out: MemoryEntry[] = []
  for (const text of texts) {
    const content = normalizeMemoryContent(text)
    if (content === '') continue
    const key = memoryEntryKey(content)
    if (key === '' || seen.has(key)) continue
    seen.add(key)

    const old = byKey.get(key)
    if (old) {
      out.push({ ...old, content, sourceMessageIds: [...old.sourceMessageIds] })
    } else {
      out.push({
        id: randomUUID(),
        content,
        source: 'repair',
        sourceMessageIds: [],
        createdAt: now,
        updatedAt: now
      })
    }
  }
  return out
}

/**
 * 修正记忆：按修改点附近 + 最近的聊天记录重写三层。
 * 乐观并发：请求前记下 revision，回来时对不上（用户中途改过记忆）就放弃，绝不覆盖。
 */
async function runRefresh(
  cardId: string,
  convId: string,
  anchor: number | undefined,
  signal: AbortSignal
): Promise<void> {
  const card = getCard(cardId)
  const conv = await getConversation(cardId, convId)
  if (!card || !conv) return

  const config = resolveMemoryConfig(card)
  if (!config.enabled) return

  const memory = normalizeMemory(conv.memory)
  const messages = collectRefreshMessages(conv.messages, anchor)
  if (messages.length === 0) return

  const revision = memory.revision
  const hadEntries = memory.short.length + memory.long.length + memory.permanent.length > 0

  try {
    let provider: Provider | undefined
    try {
      provider = getCurrentProvider()
    } catch {
      provider = undefined
    }
    if (!provider) throw new ChatError('还没有配置供应商，请到「API 配置」里添加一个')
    const model = (card.model ?? '').trim() || provider.model
    if (model.trim() === '') throw new ChatError('请先填写模型名称')

    const raw = await requestCompletion(
      provider,
      { temperature: TASK_TEMPERATURE, maxTokens: TASK_MAX_TOKENS },
      model,
      buildRefreshMessages(card.name, memory, messages),
      signal
    )

    const layers = parseRefreshResult(raw)
    if (!layers) throw new ChatError('记忆整理返回的格式不正确', raw.trim().slice(0, 300))
    const empty =
      layers.short.length === 0 && layers.long.length === 0 && layers.permanent.length === 0
    if (empty && hadEntries) {
      throw new ChatError('记忆整理没有返回可用的内容', raw.trim().slice(0, 300))
    }

    const applied = await applyRefresh(cardId, convId, revision, layers)
    if (applied) notify({ type: 'updated', cardId, convId })
  } catch (err) {
    if (signal.aborted) return
    const mapped =
      err instanceof ChatError
        ? err
        : new ChatError(err instanceof Error ? err.message : String(err))
    await recordFailure(cardId, convId, mapped)
    notify({
      type: 'error',
      cardId,
      convId,
      message: mapped.message,
      detail: mapped.detail
    })
  }
}

async function applyRefresh(
  cardId: string,
  convId: string,
  revision: number,
  layers: RefreshLayers
): Promise<boolean> {
  return withConvLock(cardId, convId, async () => {
    const latest = await getConversation(cardId, convId)
    if (!latest) return false

    const memory = normalizeMemory(latest.memory)
    if (memory.revision !== revision) return false

    const now = Date.now()
    memory.short = rebuildLayer(layers.short, memory.short, now)
    memory.long = rebuildLayer(layers.long, memory.long, now)
    memory.permanent = rebuildLayer(layers.permanent, memory.permanent, now)
    memory.revision += 1
    memory.lastRunAt = now
    memory.failCount = 0
    memory.lastError = undefined
    memory.retryAfter = undefined
    latest.memory = memory
    await saveConversation(latest)
    return true
  })
}

async function recordFailure(
  cardId: string,
  convId: string,
  error: ChatError
): Promise<void> {
  await withConvLock(cardId, convId, async () => {
    const conv = await getConversation(cardId, convId)
    if (!conv) return
    const memory: ConversationMemory = normalizeMemory(conv.memory)
    memory.failCount += 1
    memory.lastError = error.message
    memory.retryAfter =
      Date.now() +
      Math.min(BACKOFF_BASE * 2 ** Math.max(0, memory.failCount - 1), BACKOFF_MAX)
    memory.revision += 1
    conv.memory = memory
    await saveConversation(conv)
  }).catch(() => {})
}
