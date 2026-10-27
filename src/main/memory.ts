// 记忆纯逻辑：标记解析、流式过滤器、JSON 容错、去重、总结提示词。
// 只做纯函数/无副作用；网络与落盘在 memoryService.ts。规范见 docs/tech.md §9.3。

import type { ChatMessage, ConversationMemory, MemoryEntry } from '@shared/types'
import { memoryEntryKey, normalizeMemoryContent } from '@shared/memory'
import type { WireMessage } from './worldbook'

export interface ParsedMemoryMarkers {
  /** 去掉记忆标记后的正文（用于气泡、落盘、done/aborted 事件） */
  cleaned: string
  /** 标记里取出的条目（已 trim、去空、单条 300 字、同轮去重、最多 5 条） */
  entries: string[]
  /** 有未闭合的标记；其内容已丢弃 */
  hadUnclosed: boolean
}

const START_TOKENS = ['【记忆】', '[记忆]'] as const
const END_TOKENS = ['【/记忆】', '[/记忆]'] as const
const MAX_ENTRIES_PER_REPLY = 5

function matchAny(text: string, index: number, tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (text.startsWith(token, index)) return token
  }
  return null
}

function splitEntries(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => normalizeMemoryContent(line))
    .filter((line) => line !== '')
}

/**
 * 从 assistant 回复里摘出记忆标记。
 * - 只处理成对标记；未闭合的从标记起到文本末尾丢弃，不写记忆
 * - 代码围栏（```）里的标记不解析，按普通文字保留
 * - 条目按行拆，单条 300 字，同轮去重，最多 5 条
 */
export function parseMemoryMarkers(text: string): ParsedMemoryMarkers {
  let out = ''
  let i = 0
  let inFence = false
  let inMarker = false
  let markerBuf = ''
  let hadUnclosed = false
  let removed = false
  const entries: string[] = []
  const seen = new Set<string>()

  const flushMarker = (): void => {
    if (entries.length >= MAX_ENTRIES_PER_REPLY) {
      markerBuf = ''
      return
    }
    for (const entry of splitEntries(markerBuf)) {
      if (entries.length >= MAX_ENTRIES_PER_REPLY) break
      const key = memoryEntryKey(entry)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
    markerBuf = ''
  }

  while (i < text.length) {
    const atLineStart = i === 0 || text[i - 1] === '\n'

    // 代码围栏只在行首切换；围栏里的内容一律按普通文字
    if (!inMarker && atLineStart && text.startsWith('```', i)) {
      inFence = !inFence
      out += '```'
      i += 3
      continue
    }

    if (!inFence) {
      if (inMarker) {
        const end = matchAny(text, i, END_TOKENS)
        if (end) {
          inMarker = false
          flushMarker()
          removed = true
          i += end.length
          continue
        }
        markerBuf += text[i]
        i += 1
        continue
      }

      const start = matchAny(text, i, START_TOKENS)
      if (start) {
        inMarker = true
        markerBuf = ''
        removed = true
        i += start.length
        continue
      }
    }

    out += text[i]
    i += 1
  }

  if (inMarker) hadUnclosed = true

  // 标记被摘掉后不要把多出来的空行留在正文里；没动过就保持原样
  if (removed) {
    out = out.replace(/\n{3,}/g, '\n\n').trimEnd()
    if (out.trim() === '') out = ''
  }

  return { cleaned: out, entries, hadUnclosed }
}

/** 流式显示的尾部保护：末尾可能是标记/围栏的前缀时先不吐 */
function safePrefixLength(text: string): number {
  const tokens = [...START_TOKENS, ...END_TOKENS, '```']
  let hold = 0
  for (const token of tokens) {
    const max = Math.min(token.length - 1, text.length)
    for (let len = max; len >= 1; len--) {
      if (text.endsWith(token.slice(0, len))) {
        hold = Math.max(hold, len)
        break
      }
    }
  }
  return Math.max(0, text.length - hold)
}

/**
 * 流式过滤器：每次 push 把累计文本重新解析一遍，只 emit「确定不是标记」的部分。
 * 末尾的标记/围栏前缀先挂起，等下一块到了再判断；finish 时补发挂起的普通文字。
 *
 * 用「全量重解析」换实现简单：回复通常只有几千字，逐块 O(n²) 在这个体量下可接受，
 * 也避免了手写增量状态机在「前缀跨块/围栏嵌套」上的边界 bug。
 */
export class MemoryFilter {
  private buf = ''
  private emitted = ''
  private last: ParsedMemoryMarkers | null = null

  push(chunk: string, emit: (visible: string) => void): void {
    this.buf += chunk
    const parsed = parseMemoryMarkers(this.buf)
    this.last = parsed
    const safe = parsed.cleaned.slice(0, safePrefixLength(parsed.cleaned))
    if (!safe.startsWith(this.emitted)) return
    const delta = safe.slice(this.emitted.length)
    if (delta === '') return
    this.emitted = safe
    emit(delta)
  }

  finish(emit?: (visible: string) => void): ParsedMemoryMarkers {
    const parsed = this.last ?? parseMemoryMarkers(this.buf)
    if (emit && parsed.cleaned.startsWith(this.emitted)) {
      const delta = parsed.cleaned.slice(this.emitted.length)
      if (delta !== '') {
        this.emitted = parsed.cleaned
        emit(delta)
      }
    }
    return parsed
  }
}

// ---------- JSON 容错 ----------

/** 尽量从一段文本里抠出 JSON：直解 → 去 ```json 围栏 → 截第一个 { } / [ ] */
export function parseJsonLoose(raw: string): unknown {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  try {
    return JSON.parse(text)
  } catch {
    /* 继续尝试截取 */
  }

  const objStart = text.indexOf('{')
  const objEnd = text.lastIndexOf('}')
  if (objStart >= 0 && objEnd > objStart) {
    try {
      return JSON.parse(text.slice(objStart, objEnd + 1))
    } catch {
      /* 继续 */
    }
  }

  const arrStart = text.indexOf('[')
  const arrEnd = text.lastIndexOf(']')
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(text.slice(arrStart, arrEnd + 1))
    } catch {
      /* 继续 */
    }
  }

  return null
}

/** 从总结/沉淀响应里取出一组条目字符串（容错对象、数组、`- ` 行） */
export function extractEntryStrings(raw: string): string[] {
  const parsed = parseJsonLoose(raw)
  const out: string[] = []

  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item)
    } else if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      if (obj.entries !== undefined) collect(obj.entries)
    }
  }

  if (parsed !== null) collect(parsed)

  // JSON 完全解析失败时，退回按行提取（只认真正的列表行，避免把 JSON 碎片当记忆）
  if (out.length === 0) {
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!/^[-*•]\s+/.test(trimmed)) continue
      const text = trimmed.replace(/^[-*•]\s*/, '').trim()
      if (text !== '') out.push(text)
    }
  }

  return out
}

/** 与已有条目/同轮条目去重：规范化后完全相同、或一方包含另一方都算重复 */
export function dedupeEntryTexts(existing: MemoryEntry[], incoming: string[]): string[] {
  const keys = existing.map((e) => memoryEntryKey(e.content)).filter((k) => k !== '')
  const out: string[] = []

  const isDup = (key: string): boolean =>
    keys.some((k) => k === key || k.includes(key) || key.includes(k))

  for (const raw of incoming) {
    const text = normalizeMemoryContent(raw)
    if (text === '') continue
    const key = memoryEntryKey(text)
    if (key === '' || isDup(key)) continue
    keys.push(key)
    out.push(text)
  }
  return out
}

// ---------- 修正记忆（见 docs/tech.md §9.6） ----------

export interface RefreshLayers {
  short: string[]
  long: string[]
  permanent: string[]
}

/** 修正提示词：当前三层记忆 + 修改点附近/最近的聊天记录 → 完整三层 JSON */
export function buildRefreshMessages(
  cardName: string,
  memory: ConversationMemory,
  messages: ChatMessage[]
): WireMessage[] {
  const layerText = (entries: MemoryEntry[]): string =>
    entries.length > 0 ? entries.map((entry) => `- ${entry.content}`).join('\n') : '（无）'
  const dialogue = messages
    .map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.content}`)
    .join('\n')

  return [
    {
      role: 'system',
      content:
        '你是记忆整理助手。根据当前三层记忆和最近的聊天记录，输出修正后的完整三层记忆。\n' +
        '只输出 JSON，不要解释、不要代码围栏：\n' +
        '{"short":["一句话事实"],"long":["压缩后的故事或设定"],"permanent":["身份、关系、重大转折"]}\n' +
        '规则：合并重复；新信息覆盖旧信息；删掉与聊天记录矛盾的旧内容；' +
        'short 放最新的事实（最多 25 条），long 放压缩后的故事与设定，permanent 放最稳定的身份与关系；' +
        '每条不超过 300 字。'
    },
    {
      role: 'user',
      content:
        `角色：${cardName}\n\n` +
        `【当前短期记忆】\n${layerText(memory.short)}\n\n` +
        `【当前长期记忆】\n${layerText(memory.long)}\n\n` +
        `【当前永久记忆】\n${layerText(memory.permanent)}\n\n` +
        `【聊天记录片段】\n${dialogue}`
    }
  ]
}

/**
 * 解析修正结果：必须是含 short / long / permanent 之一的对象。
 * 解析失败或形状完全不对 → `null`（调用方按失败处理，原记忆完全不变）。
 */
export function parseRefreshResult(raw: string): RefreshLayers | null {
  const parsed = parseJsonLoose(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const obj = parsed as Record<string, unknown>
  if (!('short' in obj) && !('long' in obj) && !('permanent' in obj)) return null

  const pickLayer = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => normalizeMemoryContent(item))
      .filter((item) => item !== '')
  }

  return {
    short: pickLayer(obj.short),
    long: pickLayer(obj.long),
    permanent: pickLayer(obj.permanent)
  }
}

// ---------- 提示词 ----------

// ---------- 向上沉淀 ----------

export type ConsolidationTarget = 'long' | 'permanent'

/** 沉淀：把一批短期/长期条目合成 1 条上层记忆（见 docs/tech.md §9.5） */
export function buildConsolidationMessages(
  cardName: string,
  target: ConsolidationTarget,
  entries: MemoryEntry[]
): WireMessage[] {
  const sourceLabel = target === 'long' ? '短期记忆' : '长期记忆'
  const targetLabel = target === 'long' ? '长期记忆' : '永久记忆'
  const rules =
    target === 'long'
      ? '合并重复；新信息覆盖旧信息；删掉琐碎内容；只保留身份、关系、重要事件、偏好、约定'
      : '只保留身份、关系、长期设定与重大转折；删掉细节、临时事件与重复内容'

  return [
    {
      role: 'system',
      content:
        `你是记忆整理助手。把这些${sourceLabel}合并压缩成一条${targetLabel}。\n` +
        '只输出 JSON，不要解释、不要代码围栏：\n' +
        `{"${target}":"……"}\n` +
        `规则：${rules}；写成 1–3 句连贯的话；不超过 300 字。`
    },
    {
      role: 'user',
      content:
        `角色：${cardName}\n\n【待合并的${sourceLabel}】\n` +
        entries.map((entry) => `- ${entry.content}`).join('\n')
    }
  ]
}

/**
 * 从沉淀响应里取出那一条文本：
 * - 认 `{"long":"…"}` / `{"permanent":"…"}`
 * - 也认数组形式 `{"long":["…","…"]}`：拼接后由 normalizeMemoryContent 截到 300 字
 * - **解析失败返回 `null`**（调用方报「格式不正确」）
 * - 解析成功但没有可用文本返回 `''`（调用方报「没有返回可用的内容」）
 * 两种情况都视为失败，原记忆完全不变。
 */
export function extractConsolidationText(
  raw: string,
  target: ConsolidationTarget
): string | null {
  const parsed = parseJsonLoose(raw)
  if (parsed === null) return null
  if (typeof parsed === 'string') return normalizeMemoryContent(parsed)

  const pick = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string').join(' ')
    }
    return ''
  }

  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    for (const key of [target, 'content', 'entry', 'memory', 'text']) {
      const text = pick(obj[key])
      if (text.trim() !== '') return normalizeMemoryContent(text)
    }
    // 兜底：对象里恰好只有一个字符串值时就认它
    const values = Object.values(obj).map(pick).filter((v) => v.trim() !== '')
    if (values.length === 1) return normalizeMemoryContent(values[0])
  }

  return ''
}

/** 兜底总结：把一段对话压成短期事实 */
export function buildSummaryMessages(
  cardName: string,
  chunk: ChatMessage[],
  existingShort: MemoryEntry[]
): WireMessage[] {
  const dialogue = chunk
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
    .join('\n')
  const existing =
    existingShort.length > 0
      ? existingShort.map((e) => `- ${e.content}`).join('\n')
      : '（无）'

  return [
    {
      role: 'system',
      content:
        '你是记忆整理助手。根据对话片段和已有短期记忆，提取值得长期记住的事实。\n' +
        '只输出 JSON，不要解释、不要代码围栏：\n' +
        '{"entries":["一句话事实","..."]}\n' +
        '规则：每条一句话；只写事实（身份、关系、承诺、重要事件、喜好、约定）；' +
        '合并重复；不写猜测、寒暄、动作描写；最多 12 条；每条不超过 300 字。'
    },
    {
      role: 'user',
      content:
        `角色：${cardName}\n\n` +
        `【已有短期记忆】\n${existing}\n\n` +
        `【待整理对话】\n${dialogue}`
    }
  ]
}
