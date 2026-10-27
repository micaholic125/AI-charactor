// 卡片的导入与导出：自有格式 + Dify 的 app 配置识别与映射、头像往返、导入报告。
// 规范见 docs/tech.md §3「卡片的外部格式与导入映射」。
//
// 三条硬规矩（同 §3）：
//  ① 不把外部格式的三区结构（前置词 / 提示词 / 后置词）暴露到界面上——前置词与正文折成
//     「角色设定」，只有后置词单独留字段（它必须待在消息末尾才有效）
//  ② 不认识的、装不进来的，一律写进「导入报告」，**绝不静默丢弃**
//  ③ 只处理用户选中的文件：不联网抓取卡片、不调任何站点的接口、不做批量下载

import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import type { Card, ExportedCard, ImportReport, WorldbookEntry } from '@shared/types'
import { getAvatarsDir, getCard, isSafeAvatarName, saveCard, writeAvatarFile } from './store'

/** 头像上限，与 avatar:pick 保持一致 */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024
/** 下载外部图标（Dify 的 http 头像）的超时 */
const ICON_TIMEOUT_MS = 10_000

// ---------- 导出 ----------

/** 导出这张卡：弹保存对话框，写自有格式的 JSON（头像内嵌为 base64）。用户取消时 path 为 null */
export async function exportCard(
  win: BrowserWindow | null,
  cardId: string
): Promise<{ path: string | null }> {
  const card = getCard(cardId)
  if (!card) throw new Error('卡片不存在')

  const options: Electron.SaveDialogOptions = {
    title: '导出聊天卡',
    buttonLabel: '导出',
    defaultPath: `${safeFileName(card.name)}.json`,
    filters: [{ name: '聊天卡', extensions: ['json'] }]
  }
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { path: null }

  const payload: ExportedCard = { format: 'ai-chat-cards', version: 1, card }
  const dataUrl = card.avatar ? await readAvatarDataUrl(card.avatar) : null
  if (dataUrl) payload.avatarDataUrl = dataUrl

  await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8')
  return { path: result.filePath }
}

/** 卡名里的非法文件名字符换掉，免得保存对话框打不开 */
function safeFileName(name: string): string {
  const cleaned = (name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim()
  return cleaned === '' ? '聊天卡' : cleaned
}

/** 把头像文件读成 data URL；读不到返回 null（导出时就不带 avatarDataUrl） */
async function readAvatarDataUrl(fileName: string): Promise<string | null> {
  if (!isSafeAvatarName(fileName)) return null
  const mime = mimeOf(extname(fileName).slice(1).toLowerCase())
  if (!mime) return null
  try {
    const buf = await fs.readFile(join(getAvatarsDir(), fileName))
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

function mimeOf(ext: string): string | null {
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return null
}

// ---------- 导入 ----------

/** 导入：弹文件对话框（可多选），逐个识别并落盘。**一张失败不影响其余**，永不抛异常 */
export async function importCards(win: BrowserWindow | null): Promise<ImportReport[]> {
  const options: Electron.OpenDialogOptions = {
    title: '导入聊天卡',
    buttonLabel: '导入',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '聊天卡 / Dify 配置', extensions: ['json'] }]
  }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return []

  const reports: ImportReport[] = []
  for (const file of result.filePaths) reports.push(await importOneFile(file))
  return reports
}

async function importOneFile(file: string): Promise<ImportReport> {
  const fileName = basename(file)
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return {
      fileName,
      ok: false,
      kind: 'unknown',
      warnings: [],
      error: '文件读不出来：可能不是 JSON 文件，或内容已损坏'
    }
  }

  try {
    const own = asOwnFormat(raw)
    if (own) return await importOwnFormat(fileName, own)

    const dify = asDifyConfig(raw)
    if (dify) return await importDifyFormat(fileName, dify)
  } catch (err) {
    return {
      fileName,
      ok: false,
      kind: 'unknown',
      warnings: [],
      error: `导入失败：${err instanceof Error ? err.message : String(err)}`
    }
  }

  return {
    fileName,
    ok: false,
    kind: 'unknown',
    warnings: [],
    error: '认不出这个文件的格式：既不是本应用导出的卡，也不是 Dify 的 app 配置'
  }
}

// ---------- 自有格式 ----------

function asOwnFormat(raw: unknown): ExportedCard | null {
  if (!isObj(raw)) return null
  if (raw.format !== 'ai-chat-cards') return null
  if (!isObj(raw.card)) return null
  return raw as unknown as ExportedCard
}

async function importOwnFormat(fileName: string, payload: ExportedCard): Promise<ImportReport> {
  const warnings: string[] = []
  const newId = randomUUID()
  const card = buildImportedCard(payload.card as Partial<Card>, newId)

  // 头像：base64 → 写进 avatars/
  const dataUrl = payload.avatarDataUrl
  if (typeof dataUrl === 'string' && dataUrl !== '') {
    const parsed = parseDataUrl(dataUrl)
    if (!parsed) warnings.push('头像数据看不懂，已用默认头像')
    else if (parsed.bytes.length > MAX_AVATAR_BYTES) warnings.push('头像超过 5MB，已用默认头像')
    else {
      try {
        card.avatar = await writeAvatarFile(newId, parsed.bytes, parsed.ext)
      } catch {
        warnings.push('头像写入失败，已用默认头像')
      }
    }
  }

  const saved = await saveCard(card)
  return {
    fileName,
    ok: true,
    kind: 'own',
    cardId: saved.id,
    cardName: saved.name,
    summary: summarize(saved),
    warnings
  }
}

/** 把任意来源的卡片字段收拾成一张干净的新卡（id 与世界书条目 id 全部换新） */
function buildImportedCard(raw: Partial<Card>, newId: string): Card {
  const now = Date.now()
  const entries = Array.isArray(raw.worldbook) ? raw.worldbook : []
  return {
    id: newId,
    name: str(raw.name).trim() || '未命名卡片',
    systemPrompt: str(raw.systemPrompt),
    prePrompt: str(raw.prePrompt).trim(),
    suffix: str(raw.suffix).trim(),
    greeting: str(raw.greeting),
    worldbook: entries.map((e) => ({
      // 条目 id 也要换新：跟「建分支」同规矩，导进来的卡是独立个体
      id: randomUUID(),
      title: str(e?.title),
      content: str(e?.content),
      keywords: Array.isArray(e?.keywords) ? e.keywords.map((k) => str(k)) : [],
      order: num(e?.order) ?? 0,
      alwaysOn: e?.alwaysOn === true
    })),
    model: str(raw.model).trim() || undefined,
    stream: typeof raw.stream === 'boolean' ? raw.stream : undefined,
    temperature: num(raw.temperature) ?? undefined,
    maxTokens: num(raw.maxTokens) ?? undefined,
    // 记忆设置：自有格式往返时一并带走；老文件没有这些字段 = 用默认值
    memoryEnabled: typeof raw.memoryEnabled === 'boolean' ? raw.memoryEnabled : undefined,
    memoryRecentCount: num(raw.memoryRecentCount) ?? undefined,
    memoryShortLimit: num(raw.memoryShortLimit) ?? undefined,
    memoryShortBatch: num(raw.memoryShortBatch) ?? undefined,
    memoryLongLimit: num(raw.memoryLongLimit) ?? undefined,
    memoryLongBatch: num(raw.memoryLongBatch) ?? undefined,
    createdAt: now,
    updatedAt: now
  }
}

function summarize(card: Card): ImportReport['summary'] {
  return {
    promptChars: card.systemPrompt.trim().length,
    prePromptChars: card.prePrompt.trim().length,
    suffixChars: card.suffix.trim().length,
    worldbookEntries: card.worldbook.length,
    hasGreeting: card.greeting.trim() !== ''
  }
}

// ---------- Dify 的 app 配置 ----------

interface DifyConfig {
  apps: Record<string, unknown>
  model_config: Record<string, unknown>
}

/** 根对象或 `data` 下有 `model_config` 对象即认定（见 docs/tech.md §3） */
function asDifyConfig(raw: unknown): DifyConfig | null {
  if (!isObj(raw)) return null
  const data = isObj(raw.data) ? raw.data : raw
  if (!isObj(data.model_config)) return null
  return {
    apps: isObj(data.apps) ? data.apps : {},
    model_config: data.model_config
  }
}

async function importDifyFormat(fileName: string, dify: DifyConfig): Promise<ImportReport> {
  const mc = dify.model_config
  const apps = dify.apps
  const warnings: string[] = []

  // --- 前置词：**单独一个字段**，不折进正文（见 docs/tech.md §3 硬规矩 ①）---
  const prePrompt = str(mc.pre_prompt).trim()

  // --- 正文：chat_prompt_config 的块 + completion 里的 prompt.text，按顺序拼成一段 ---
  const parts = promptBlocks(mc.chat_prompt_config)

  const completion = jsonObject(mc.completion_prompt_config)
  const completionPrompt = isObj(completion?.prompt) ? str(completion.prompt.text).trim() : ''
  if (completionPrompt !== '') parts.push(completionPrompt)

  const systemPrompt = parts.filter((p) => p !== '').join('\n\n')
  // 后置词：单独留字段——它必须待在消息末尾才有效（见 docs/tech.md §6）
  const suffix = completion ? str(completion.post_prompt).trim() : ''

  // --- 世界书：外部是一整段文本，整段作为一条「常驻」条目，不按关键词切 ---
  const worldbookText = str(mc.world_book).trim()
  const worldbook: WorldbookEntry[] =
    worldbookText === ''
      ? []
      : [
          {
            id: randomUUID(),
            title: '世界书',
            content: worldbookText,
            keywords: [],
            order: 0,
            alwaysOn: true
          }
        ]

  // --- 被平台挖空的正文：字段是空的，但文件里留了长度记录，必须直说 ---
  if (systemPrompt === '' && prePrompt === '') {
    const len = num(mc.pre_length) ?? num(mc.pre_prompt_and_pre_post_text_length) ?? 0
    warnings.push(
      len > 0
        ? `这张卡的提示词在文件里是空的（导出它的平台没有下发，原本有 ${len} 字），需要自己补`
        : '这张卡的提示词在文件里是空的，需要自己补'
    )
  } else if (systemPrompt === '') {
    warnings.push('这张卡只有前置词、没有提示词正文（正文在文件里是空的），需要自己补')
  }
  if (worldbookText === '') {
    const len = num(mc.world_book_length) ?? 0
    if (len > 0) {
      warnings.push(`世界书在文件里是空的（导出它的平台没有下发，原本有 ${len} 字）`)
    }
  }

  // --- 忽略的展示字段：说了才叫「不静默丢弃」 ---
  const displayKeys = ['description', 'tags', 'author', 'icon_url', 'mode', 'prompt_type']
  const present = displayKeys.filter((k) => {
    const v = apps[k]
    return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)
  })
  if (present.length > 0) {
    warnings.push(`已忽略展示字段：${present.join('、')}（不属于聊天数据，导入也用不上）`)
  }

  // --- 暂不支持项：同样进报告，不静默 ---
  const params = isObj(mc.model) && isObj(mc.model.completion_params) ? mc.model.completion_params : null
  if (params) {
    const unsupported = ['top_p', 'top_k', 'presence_penalty', 'frequency_penalty'].filter(
      (k) => num(params[k]) !== null
    )
    if (unsupported.length > 0) {
      warnings.push(
        `这些参数暂时还没做成卡片级，已忽略：${unsupported.join('、')}（温度与最大长度已经带过来了）`
      )
    }
  }
  const hist = jsonObject(mc.conversation_histories_role)
  if (hist && (str(hist.user_prefix).trim() !== '' || str(hist.assistant_prefix).trim() !== '')) {
    warnings.push('这张卡给每条历史消息加了前后缀，本地没有对应位置，已忽略')
  }

  // --- 组装并落盘 ---
  const newId = randomUUID()
  const card = buildImportedCard(
    {
      name: str(apps.name) || str(mc.name) || stripExt(fileName),
      systemPrompt,
      prePrompt,
      suffix,
      greeting: str(mc.opening_statement),
      worldbook,
      model: isObj(mc.model) ? str(mc.model.name).trim() || undefined : undefined,
      temperature: isObj(mc.model) ? (num(mc.model.temperature) ?? undefined) : undefined,
      maxTokens: isObj(mc.model) ? (num(mc.model.max_tokens) ?? undefined) : undefined
    },
    newId
  )

  // 头像：外部是 http 图标 → 下载存本地；失败留空并写进报告
  const iconUrl = str(apps.icon).trim()
  if (iconUrl !== '') {
    const icon = await downloadIcon(iconUrl)
    if (!icon) warnings.push('头像下载失败（超时、超过 5MB、或地址打不开），已用默认头像')
    else {
      try {
        card.avatar = await writeAvatarFile(newId, icon.bytes, icon.ext)
      } catch {
        warnings.push('头像写入失败，已用默认头像')
      }
    }
  }

  const saved = await saveCard(card)
  return {
    fileName,
    ok: true,
    kind: 'dify',
    cardId: saved.id,
    cardName: saved.name,
    summary: summarize(saved),
    warnings
  }
}

/**
 * `chat_prompt_config` 是「JSON 字符串」，**形状有两种**：`{"prompt":[…]}` 与裸数组 `[…]`。
 * **两种都要认**——只认一种会把提示词正文**整段静默丢掉**（见 docs/tech.md §3）。
 * 逐块取 `text` 顺序拼接；块上的 `role` 不保留（本地折成一段，没有对应位置）。
 */
function promptBlocks(v: unknown): string[] {
  const parsed = jsonParse(v)
  const list = Array.isArray(parsed)
    ? parsed
    : isObj(parsed) && Array.isArray(parsed.prompt)
      ? parsed.prompt
      : []
  return list
    .map((b) => (typeof b === 'string' ? b.trim() : isObj(b) ? str(b.text).trim() : ''))
    .filter((t) => t !== '')
}

// ---------- 头像下载 ----------

async function downloadIcon(
  url: string
): Promise<{ bytes: Uint8Array; ext: string } | null> {
  if (!/^https?:\/\//i.test(url)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ICON_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return null
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) return null

    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null

    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    const ext = ct.includes('png')
      ? 'png'
      : ct.includes('webp')
        ? 'webp'
        : ct.includes('gif')
          ? 'gif'
          : 'jpg'
    return { bytes, ext }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** `data:image/png;base64,xxxx` → 字节 + 扩展名 */
function parseDataUrl(dataUrl: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim())
  if (!m) return null
  try {
    const bytes = Buffer.from(m[2], 'base64')
    if (bytes.length === 0) return null
    const raw = m[1].toLowerCase()
    return { bytes, ext: raw === 'jpeg' ? 'jpg' : raw }
  } catch {
    return null
  }
}

// ---------- 小工具 ----------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function jsonParse(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

function jsonObject(v: unknown): Record<string, unknown> | null {
  const parsed = jsonParse(v)
  return isObj(parsed) ? parsed : null
}

function stripExt(fileName: string): string {
  const base = basename(fileName)
  const ext = extname(base)
  return ext === '' ? base : base.slice(0, -ext.length)
}
