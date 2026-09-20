// 世界书注入算法 + 消息组装（纯函数，无副作用，方便单独验证）
// 规范见 docs/tech.md §6

import type { Card, ChatMessage, WorldbookEntry } from '@shared/types'

/** 发给 API 的消息（OpenAI 兼容格式） */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 关键词扫描窗口：最近 N 条历史消息 + 当前用户消息 */
const SCAN_WINDOW = 8

/**
 * 挑出本次要注入的世界书条目：
 * 激活条件 = 常驻，或任一关键词出现在扫描窗口里；
 * 结果按 order 升序（平局按标题），同 id 只保留一条。
 */
export function pickActiveEntries(
  worldbook: WorldbookEntry[],
  history: ChatMessage[],
  currentText: string
): WorldbookEntry[] {
  const window = [...history.slice(-SCAN_WINDOW).map((m) => m.content), currentText]
    .join('\n')
    .toLowerCase()

  const seen = new Set<string>()
  const active: WorldbookEntry[] = []
  for (const entry of worldbook ?? []) {
    if (!entry || seen.has(entry.id)) continue
    const hit =
      entry.alwaysOn ||
      (entry.keywords ?? []).some((raw) => {
        const kw = (raw ?? '').trim().toLowerCase()
        return kw !== '' && window.includes(kw)
      })
    if (!hit) continue
    seen.add(entry.id)
    active.push(entry)
  }

  return active.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh'))
}

/** 把激活条目拼成注入块；没有条目时返回空串 */
export function buildWorldbookBlock(entries: WorldbookEntry[]): string {
  if (entries.length === 0) return ''
  const parts = entries.map((e) => `# ${e.title}\n${e.content}`)
  return `[世界书条目]\n${parts.join('\n\n')}`
}

/**
 * 组装完整请求消息：
 * 首条 system =「世界书块 + 空行 + 角色设定」（任一为空则只留另一个），
 * 之后是全部历史消息，最后是当前用户消息。
 *
 * `currentText` 可以省略：**重新输出**时没有新的用户输入，历史本身就是全部内容，
 * 硬塞一条空的 user 消息会让 AI 以为用户说了句空话。见 docs/tech.md §6。
 */
export function buildMessages(
  card: Card,
  history: ChatMessage[],
  currentText?: string
): WireMessage[] {
  const text = currentText ?? ''
  const block = buildWorldbookBlock(pickActiveEntries(card.worldbook, history, text))
  const prompt = (card.systemPrompt ?? '').trim()
  const system = [block, prompt].filter((s) => s !== '').join('\n\n')

  const messages: WireMessage[] = []
  if (system !== '') messages.push({ role: 'system', content: system })
  for (const m of history) {
    if (m && m.content) messages.push({ role: m.role, content: m.content })
  }
  if (text.trim() !== '') messages.push({ role: 'user', content: text })
  return messages
}
