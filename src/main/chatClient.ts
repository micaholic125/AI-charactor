// 聊天客户端：流式（SSE 逐块）/ 非流式（整段一次返回）、并发注册表、中止、中文错误映射、连通性测试
// 规范见 docs/tech.md §7。零依赖，只用 Node 内置 fetch / ReadableStream。

import type { Provider } from '@shared/types'
import type { WireMessage } from './worldbook'

/** 带「原始详情」的错误：message 是给用户看的中文，detail 放技术信息（灰色小字） */
export class ChatError extends Error {
  detail?: string
  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'ChatError'
    this.detail = detail
  }
}

// ---------- 并发注册表（同一对话同时只能有一个流） ----------

const active = new Map<string, AbortController>()

export const streamKey = (cardId: string, convId: string): string => `${cardId}:${convId}`

export function isStreaming(cardId: string, convId: string): boolean {
  return active.has(streamKey(cardId, convId))
}

export function abortStream(cardId: string, convId: string): void {
  active.get(streamKey(cardId, convId))?.abort()
}

export function abortAllStreams(): void {
  for (const controller of active.values()) controller.abort()
}

// ---------- URL 归一 ----------

/** 把用户填的接口地址补全成 /chat/completions 的完整地址（容忍各种粘贴写法） */
export function chatCompletionsUrl(baseUrl: string): string {
  const url = (baseUrl ?? '').trim().replace(/\/+$/, '')
  if (url === '') throw new ChatError('请先填写接口地址')
  if (/\/chat\/completions$/i.test(url)) return url
  if (/\/v\d+[a-z]*$/i.test(url)) return `${url}/chat/completions`
  return `${url}/v1/chat/completions`
}

/** 同理补全出「模型列表」的地址（OpenAI 兼容的 GET {地址}/models） */
export function modelsUrl(baseUrl: string): string {
  const url = (baseUrl ?? '').trim().replace(/\/+$/, '')
  if (url === '') throw new ChatError('请先填写接口地址')
  if (/\/models$/i.test(url)) return url
  if (/\/chat\/completions$/i.test(url)) return `${url.replace(/\/chat\/completions$/i, '')}/models`
  if (/\/v\d+[a-z]*$/i.test(url)) return `${url}/models`
  return `${url}/v1/models`
}

// ---------- 错误映射 ----------

/** 从 API 的响应体里尽力抽出可读的错误说明 */
function extractApiMessage(body: string): string {
  try {
    const data = JSON.parse(body) as {
      error?: { message?: string }
      message?: string
    }
    return (data?.error?.message ?? data?.message ?? '').trim()
  } catch {
    return ''
  }
}

/** HTTP 状态码 → 中文文案（表见 docs/design.md §6） */
function mapHttpError(status: number, body: string): ChatError {
  const apiMessage = extractApiMessage(body)
  const raw = body.trim().slice(0, 300)
  const detail = apiMessage || raw || undefined

  switch (status) {
    case 401:
      return new ChatError('API Key 无效或未填写', detail)
    case 403:
      return new ChatError('没有访问权限', detail)
    case 404:
      return new ChatError('接口地址或模型名称不正确', detail)
    case 429:
      return new ChatError('请求太频繁，请稍后再试', detail)
    default:
      // 400 及其他：优先透传 API 自己的说明
      return new ChatError(apiMessage || `请求失败（HTTP ${status}）`, apiMessage ? undefined : detail)
  }
}

/** 网络层异常 → 中文文案 */
function mapNetworkError(err: unknown): ChatError {
  const name = (err as { name?: string })?.name ?? ''
  const raw = err instanceof Error ? err.message : String(err)
  if (name === 'TimeoutError') return new ChatError('连接超时，请检查网络和接口地址', raw)
  return new ChatError('无法连接服务器，请检查网络和接口地址', raw)
}

// ---------- 请求构造 ----------

/** 本次生效的采样参数（来自全局设置） */
export interface ChatParams {
  temperature: number
  maxTokens: number
}

function buildUrl(provider: Provider): string {
  return chatCompletionsUrl(provider.baseUrl)
}

function headers(provider: Provider): Record<string, string> {
  const key = (provider.apiKey ?? '').trim()
  if (key === '') throw new ChatError('API Key 无效或未填写', '请在「API 配置」里填写 API Key')
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`
  }
}

/**
 * 从一段 SSE 文本里取出增量内容；返回 null 表示没有内容。
 * 兼容 delta.content（标准）与 message.content（部分服务在结尾块给全文）。
 */
function readSseChunk(block: string): string | null {
  const lines = block.split('\n').filter((l) => l.startsWith('data:'))
  if (lines.length === 0) return null
  const payload = lines.map((l) => l.slice(5).trimStart()).join('\n').trim()
  if (payload === '' || payload === '[DONE]') return null

  let data: {
    choices?: Array<{
      delta?: { content?: string | null }
      message?: { content?: string | null }
      text?: string | null
    }>
    error?: { message?: string }
  }
  try {
    data = JSON.parse(payload)
  } catch {
    return null // 不认识的块直接忽略，避免整段回复失败
  }

  if (data?.error?.message) throw new ChatError(data.error.message)
  const choice = data?.choices?.[0]
  return choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? null
}

// ---------- 聊天请求（流式 / 非流式） ----------

export interface StreamResult {
  text: string
  aborted: boolean
}

/** 非流式响应里的候选项（各家写法略有差异） */
interface RawChoice {
  message?: { content?: unknown }
  delta?: { content?: unknown }
  text?: unknown
}
interface RawReply {
  choices?: RawChoice[]
  error?: { message?: string }
  message?: string
}

/** 取出正文：兼容字符串与「内容数组」两种写法（后者常见于多模态接口） */
function extractContent(choice: RawChoice | undefined): string {
  const raw = choice?.message?.content ?? choice?.delta?.content ?? choice?.text
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((part) =>
        typeof part === 'string' ? part : ((part as { text?: string } | null)?.text ?? '')
      )
      .join('')
  }
  return ''
}

/**
 * 非流式：一次读完整个响应体再解析。
 * 中途被中止不算错误：返回 aborted，此时还没拿到任何文本。
 */
async function readWholeReply(res: Response, controller: AbortController): Promise<StreamResult> {
  let raw = ''
  try {
    raw = await res.text()
  } catch (err) {
    if (controller.signal.aborted) return { text: '', aborted: true }
    throw err instanceof ChatError ? err : mapNetworkError(err)
  }
  if (controller.signal.aborted) return { text: '', aborted: true }

  let data: RawReply
  try {
    data = JSON.parse(raw) as RawReply
  } catch {
    throw new ChatError('接口返回的内容无法解析', raw.trim().slice(0, 300) || `HTTP ${res.status}`)
  }

  if (data?.error?.message) throw new ChatError(data.error.message)
  const choice = data?.choices?.[0]
  if (!choice) {
    // 有的服务在 HTTP 200 里塞业务错误（如 {"code":40001,"message":"..."}）
    const msg = typeof data?.message === 'string' ? data.message.trim() : ''
    if (msg !== '') throw new ChatError(msg)
    return { text: '', aborted: false } // 空回复交给上层提示「AI 没有返回内容」
  }
  return { text: extractContent(choice), aborted: false }
}

/**
 * 发起一次对话请求（流式或非流式）。
 * 流式下逐块调用 onDelta；被中止时正常返回（aborted=true），
 * 已生成的部分文本通过返回值交给调用方持久化。
 * @param provider 本次走哪条供应商（接口地址 + Key），由调用方按「当前使用中」取出
 * @param model    本次请求生效的模型名（调用方已按「卡片覆盖 > 供应商默认」决定）
 * @param stream   本次请求是否用流式（调用方已按「卡片覆盖 > 设置默认」决定）
 */
export async function requestChat(
  cardId: string,
  convId: string,
  provider: Provider,
  params: ChatParams,
  model: string,
  stream: boolean,
  messages: WireMessage[],
  onDelta: (chunk: string) => void
): Promise<StreamResult> {
  const key = streamKey(cardId, convId)
  if (active.has(key)) throw new ChatError('正在回复中，请稍候')

  const controller = new AbortController()
  active.set(key, controller)

  const useStream = stream === true
  let acc = ''
  try {
    const url = buildUrl(provider)
    const effectiveModel = (model ?? '').trim()
    if (effectiveModel === '') throw new ChatError('请先填写模型名称')
    const body = JSON.stringify({
      model: effectiveModel,
      messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      stream: useStream
    })

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: headers(provider),
        body,
        signal: controller.signal
      })
    } catch (err) {
      if (controller.signal.aborted) return { text: acc, aborted: true }
      throw err instanceof ChatError ? err : mapNetworkError(err)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw mapHttpError(res.status, text)
    }

    // 非流式：整段读完再一次交付（不发 delta）
    if (!useStream) return await readWholeReply(res, controller)

    if (!res.body) throw new ChatError('接口没有返回内容', `HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        // 统一换行符，兼容 CRLF 服务端
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')

        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const chunk = readSseChunk(block)
          if (chunk) {
            acc += chunk
            onDelta(chunk)
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return { text: acc, aborted: true }
      throw err instanceof ChatError ? err : mapNetworkError(err)
    }

    return { text: acc, aborted: false }
  } finally {
    active.delete(key)
  }
}

// ---------- 一次性补全（记忆整理用：非流式、不占聊天流式锁） ----------

/**
 * 发一次非流式请求，拿整段文本。
 * **不注册 `cardId:convId` 的流式锁**——记忆整理与正常聊天可以同时进行；
 * 超时 60 秒，外部 signal（退出应用）可以中止。规范见 docs/tech.md §9.4。
 */
export async function requestCompletion(
  provider: Provider,
  params: ChatParams,
  model: string,
  messages: WireMessage[],
  signal?: AbortSignal
): Promise<string> {
  const url = buildUrl(provider)
  const effectiveModel = (model ?? '').trim()
  if (effectiveModel === '') throw new ChatError('请先填写模型名称')

  const controller = new AbortController()
  let timedOut = false
  const onAbort = (): void => controller.abort()
  if (signal) {
    if (signal.aborted) throw new ChatError('记忆整理已中止')
    signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 60_000)

  const abortError = (): ChatError =>
    timedOut
      ? new ChatError('记忆整理超时，稍后会自动重试', '请求超过 60 秒被中止')
      : new ChatError('记忆整理已中止')

  try {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: headers(provider),
        body: JSON.stringify({
          model: effectiveModel,
          messages,
          temperature: params.temperature,
          max_tokens: params.maxTokens,
          stream: false
        }),
        signal: controller.signal
      })
    } catch (err) {
      if (controller.signal.aborted) throw abortError()
      throw err instanceof ChatError ? err : mapNetworkError(err)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw mapHttpError(res.status, text)
    }

    const result = await readWholeReply(res, controller)
    if (result.aborted) throw abortError()
    return result.text
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// ---------- 连通性测试 ----------

/** 非流式小请求探测（max_tokens:8）；成功返回 {ok:true}，失败抛出已映射的中文错误。测的是传入的这条供应商自己的模型 */
export async function testConnection(provider: Provider): Promise<{ ok: boolean }> {
  const url = buildUrl(provider)
  const model = (provider.model ?? '').trim()
  if (model === '') throw new ChatError('请先填写模型名称')
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: '你好' }],
    max_tokens: 8,
    stream: false
  })

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(provider),
      body,
      signal: AbortSignal.timeout(20000)
    })
  } catch (err) {
    throw err instanceof ChatError ? err : mapNetworkError(err)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw mapHttpError(res.status, text)
  }
  await res.text().catch(() => '') // 丢弃响应体，避免连接挂起
  return { ok: true }
}

// ---------- 模型列表（一键获取） ----------

/**
 * 名字里带这些词的都不是聊天模型（向量、重排、语音、画图、审核、OCR）。
 * 宁松勿严：滤错了用户还能在表单里手动输入模型名兜底。
 */
const NON_CHAT_HINTS = [
  'embedding',
  'rerank',
  'tts',
  'whisper',
  'speech',
  'audio',
  'dall-e',
  'dall·e',
  'image',
  'moderation',
  'ocr',
  'bge-'
]

export function isChatModel(name: string): boolean {
  const lower = name.toLowerCase()
  return !NON_CHAT_HINTS.some((hint) => lower.includes(hint))
}

/** trim → 去重（保序）→ 按字母序，便于在下拉里找 */
export function tidyModels(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    const name = (raw ?? '').trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out.sort((a, b) => a.localeCompare(b, 'en'))
}

/**
 * 从各家五花八门的响应里尽力抽出模型名。
 * 兼容：`{data:[{id}]}`（OpenAI 标准）、`{data:[{name}]}`、`{models:[...]}`、顶层数组、以及纯字符串数组。
 */
function extractModelNames(raw: string): string[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new ChatError('接口返回的内容无法解析', raw.trim().slice(0, 300) || undefined)
  }

  const root = data as { data?: unknown; models?: unknown } | null
  const list = Array.isArray(root?.data)
    ? root.data
    : Array.isArray(root?.models)
      ? root.models
      : Array.isArray(data)
        ? data
        : []

  const names: string[] = []
  for (const item of list) {
    if (typeof item === 'string') {
      names.push(item)
      continue
    }
    const obj = item as { id?: unknown; name?: unknown; model?: unknown } | null
    const value = obj?.id ?? obj?.name ?? obj?.model
    if (typeof value === 'string') names.push(value)
  }
  return names
}

/**
 * 拉取一条供应商的可用模型列表（`GET {接口地址}/models`）。
 * 失败抛出已映射的中文错误；成功返回整理好的模型名（已过滤、去重、按字母序）。
 */
export async function listModels(provider: Provider): Promise<string[]> {
  const url = modelsUrl(provider.baseUrl)

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: headers(provider),
      signal: AbortSignal.timeout(15000)
    })
  } catch (err) {
    throw err instanceof ChatError ? err : mapNetworkError(err)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // 404 多半不是「地址写错」而是这家压根没提供这个接口，给一句能落地的引导
    if (res.status === 404) {
      throw new ChatError(
        '这家服务商没有提供模型列表接口，请手动输入模型名',
        mapHttpError(res.status, text).detail
      )
    }
    throw mapHttpError(res.status, text)
  }

  const raw = await res.text().catch(() => '')
  const models = tidyModels(extractModelNames(raw).filter(isChatModel))
  if (models.length === 0) {
    throw new ChatError('这家服务商没有返回可用的模型，请手动输入模型名', raw.trim().slice(0, 300) || undefined)
  }
  return models
}
