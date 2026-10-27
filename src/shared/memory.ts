// 记忆的纯函数：默认值、归一、窗口计算、容量工具。
// 主进程与渲染层共用，**不得 import 任何 Node / Electron API**。
// 规范见 docs/tech.md §9。

import type {
  Card,
  ConversationMemory,
  MemoryEntry,
  MemoryLayer
} from './types'

// ---------- 默认值（卡片级字段缺省时使用） ----------

export const DEFAULT_MEMORY_RECENT_COUNT = 6
export const DEFAULT_MEMORY_SHORT_LIMIT = 3000
export const DEFAULT_MEMORY_SHORT_BATCH = 25
export const DEFAULT_MEMORY_LONG_LIMIT = 20
export const DEFAULT_MEMORY_LONG_BATCH = 10

/** 单条记忆硬上限（字）。超长截断并加省略号 */
export const MEMORY_ENTRY_MAX = 300

export const MEMORY_LAYERS: readonly MemoryLayer[] = ['short', 'long', 'permanent']

export interface MemoryConfig {
  enabled: boolean
  /** 每次请求带最近 N 条历史消息 */
  recentCount: number
  /** 短期容量（字） */
  shortLimit: number
  /** 短→长的条数阈值 */
  shortBatch: number
  /** 长期容量（条） */
  longLimit: number
  /** 长→永久的条数阈值 */
  longBatch: number
}

export interface MemoryCounts {
  short: number
  long: number
  permanent: number
}

const MEMORY_SOURCES: ReadonlyArray<MemoryEntry['source']> = [
  'ai',
  'summary',
  'consolidate',
  'user',
  'repair'
]

// ---------- 基础工具 ----------

export function isMemoryLayer(value: unknown): value is MemoryLayer {
  return value === 'short' || value === 'long' || value === 'permanent'
}

export function isMemorySource(value: unknown): value is MemoryEntry['source'] {
  return MEMORY_SOURCES.includes(value as MemoryEntry['source'])
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return n
}

function nonNegativeInt(value: unknown): number {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

// ---------- 卡片配置 ----------

/** 把卡片上的五个数字归一成一份可直接使用的配置；越界/垃圾值回落到默认 */
export function resolveMemoryConfig(card?: Partial<Card> | null): MemoryConfig {
  return {
    // 只有显式 false 才是关闭（旧卡没有这个字段 = 默认开）
    enabled: card?.memoryEnabled !== false,
    recentCount: clampInt(
      card?.memoryRecentCount,
      2,
      50,
      DEFAULT_MEMORY_RECENT_COUNT
    ),
    shortLimit: clampInt(card?.memoryShortLimit, 200, 20000, DEFAULT_MEMORY_SHORT_LIMIT),
    shortBatch: clampInt(card?.memoryShortBatch, 3, 100, DEFAULT_MEMORY_SHORT_BATCH),
    longLimit: clampInt(card?.memoryLongLimit, 2, 100, DEFAULT_MEMORY_LONG_LIMIT),
    longBatch: clampInt(card?.memoryLongBatch, 2, 50, DEFAULT_MEMORY_LONG_BATCH)
  }
}

// ---------- 记忆本体 ----------

export function emptyMemory(): ConversationMemory {
  return {
    version: 1,
    coveredCount: 0,
    short: [],
    long: [],
    permanent: [],
    revision: 0,
    failCount: 0
  }
}

/** 只读参考值；需要可变对象时请用 emptyMemory() */
export const EMPTY_MEMORY: ConversationMemory = emptyMemory()

/** 把任意来源的记忆收拾成合法结构；不主动改写调用方的文件 */
export function normalizeMemory(raw: unknown): ConversationMemory {
  const obj = asRecord(raw)
  if (!obj) return emptyMemory()

  const coveredCount = nonNegativeInt(obj.coveredCount)
  const revision = nonNegativeInt(obj.revision)
  const failCount = nonNegativeInt(obj.failCount)
  const lastRunAt =
    typeof obj.lastRunAt === 'number' && Number.isFinite(obj.lastRunAt)
      ? obj.lastRunAt
      : undefined
  const retryAfter =
    typeof obj.retryAfter === 'number' && Number.isFinite(obj.retryAfter)
      ? obj.retryAfter
      : undefined
  const lastError =
    typeof obj.lastError === 'string' && obj.lastError.trim() !== ''
      ? obj.lastError.trim()
      : undefined

  return {
    version: 1,
    coveredCount,
    short: normalizeEntries(obj.short, 'short'),
    long: normalizeEntries(obj.long, 'long'),
    permanent: normalizeEntries(obj.permanent, 'permanent'),
    revision,
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
    ...(lastError === undefined ? {} : { lastError }),
    failCount,
    ...(retryAfter === undefined ? {} : { retryAfter })
  }
}

function normalizeEntries(raw: unknown, layer: MemoryLayer): MemoryEntry[] {
  if (!Array.isArray(raw)) return []

  const out: MemoryEntry[] = []
  raw.forEach((item, index) => {
    const obj = asRecord(item)
    if (!obj) return

    const content = normalizeMemoryContent(obj.content)
    if (content === '') return

    const createdAt =
      typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt)
        ? obj.createdAt
        : 0
    const id =
      typeof obj.id === 'string' && obj.id !== ''
        ? obj.id
        : `legacy-mem-${layer}-${index}-${createdAt}`
    const source = isMemorySource(obj.source) ? obj.source : 'user'
    const sourceMessageIds = Array.isArray(obj.sourceMessageIds)
      ? obj.sourceMessageIds.filter((x): x is string => typeof x === 'string' && x !== '')
      : []
    const updatedAt =
      typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt)
        ? obj.updatedAt
        : undefined

    out.push({
      id,
      content,
      source,
      sourceMessageIds,
      createdAt,
      ...(updatedAt === undefined ? {} : { updatedAt })
    })
  })
  return out
}

/** 一句话一条：换行/连续空白收成一个空格，去掉首尾空白，超长截断 */
export function normalizeMemoryContent(text: unknown): string {
  if (typeof text !== 'string') return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= MEMORY_ENTRY_MAX) return oneLine
  return `${oneLine.slice(0, MEMORY_ENTRY_MAX - 1)}…`
}

/** 去重用的规范形式：去空白、中英文标点，转小写 */
export function memoryEntryKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[，。！？、；：“”‘’（）《》【】…—,\.!\?;:'"()<>\[\]]/g, '')
}

/** 一层记忆的总字数（按字符数，中文 1 字 = 1） */
export function memoryChars(entries: MemoryEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.content.trim().length, 0)
}

export function memoryCounts(memory: ConversationMemory | undefined): MemoryCounts {
  return {
    short: memory?.short.length ?? 0,
    long: memory?.long.length ?? 0,
    permanent: memory?.permanent.length ?? 0
  }
}

export function totalMemoryChars(memory: ConversationMemory | undefined): number {
  if (!memory) return 0
  return memoryChars(memory.short) + memoryChars(memory.long) + memoryChars(memory.permanent)
}

// ---------- 历史窗口 ----------

/**
 * 发送历史的起点：
 * - 最近 `recentCount` 条永远发送
 * - `coveredCount` 以内的旧原文可以省略
 * - 两者取并集：`min(max(0, len - recentCount), coveredCount)`
 *
 * `len` 必须是**不含当前用户消息**的历史条数。coveredCount 为 0 时返回 0（全量历史）。
 */
export function memoryWindowStart(
  len: number,
  coveredCount: number,
  recentCount: number
): number {
  const safeLen = Math.max(0, Math.floor(Number(len) || 0))
  const safeCovered = Math.max(0, Math.min(Math.floor(Number(coveredCount) || 0), safeLen))
  const safeRecent = Math.max(0, Math.floor(Number(recentCount) || 0))
  return Math.min(Math.max(0, safeLen - safeRecent), safeCovered)
}
