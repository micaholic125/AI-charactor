// 全部 ipcMain.handle 处理器 + 聊天编排。
// 频道名与请求/响应契约见 docs/tech.md §4。
// 抛出的 Error 会被 preload 净化后原样带到渲染层，message 一律写中文（面向用户）。

import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { extname } from 'path'
import { stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import type {
  Card,
  ChatEvent,
  ChatMessage,
  Conversation,
  DeleteMode,
  MetaStore,
  Provider,
  Settings
} from '@shared/types'
import { IPC } from '@shared/types'
import { exportCard, importCards } from './transfer'
import {
  branchConversation,
  copyAvatarFile,
  createConversation,
  deleteCard,
  deleteConversation,
  deleteMessage,
  getCard,
  getCards,
  getConversation,
  getMeta,
  getSettings,
  isSafeAvatarName,
  listConversations,
  prepareRegenerate,
  renameConversation,
  saveCard,
  saveConversation,
  saveSettings,
  updateMessage,
  updateMeta
} from './store'
import {
  ChatError,
  abortAllStreams,
  abortStream,
  isStreaming,
  listModels,
  requestChat,
  streamKey,
  testConnection
} from './chatClient'
import {
  deleteProvider,
  getCurrentProvider,
  listProviders,
  saveProvider,
  setCurrentProvider
} from './providers'
import { buildMessages, type WireMessage } from './worldbook'

const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif']

export function registerIpc(): void {
  // 卡片
  ipcMain.handle(IPC.cardsList, () => getCards())
  ipcMain.handle(IPC.cardsSave, (_e, card: Card) => saveCard(card))
  ipcMain.handle(IPC.cardsDelete, (_e, cardId: string) => deleteCard(cardId))

  // 头像
  ipcMain.handle(IPC.avatarPick, (e, cardId: string) => pickAvatar(e.sender, cardId))

  // 元数据（收藏/置顶/历史）
  ipcMain.handle(IPC.metaGet, () => getMeta())
  ipcMain.handle(IPC.metaUpdate, (_e, patch: Partial<MetaStore>) => updateMeta(patch))

  // 设置
  ipcMain.handle(IPC.settingsGet, () => getSettings())
  ipcMain.handle(IPC.settingsSave, (_e, next: Settings) => saveSettings(validateSettings(next)))

  // 供应商（API 配置栏目）
  ipcMain.handle(IPC.providersList, () => listProviders())
  ipcMain.handle(IPC.providersSave, (_e, input: Provider) => saveProvider(input))
  ipcMain.handle(IPC.providersDelete, (_e, providerId: string) => deleteProvider(providerId))
  ipcMain.handle(IPC.providersSetCurrent, (_e, providerId: string) =>
    setCurrentProvider(providerId)
  )
  // 「获取模型列表」：不抛异常（与 settings:test 同款契约），失败返回中文说明 + 原始详情
  ipcMain.handle(IPC.providersFetchModels, async (_e, input: Provider) => {
    try {
      return { ok: true, models: await listModels(validateProvider(input)) }
    } catch (err) {
      const mapped =
        err instanceof ChatError ? err : new ChatError(err instanceof Error ? err.message : String(err))
      return { ok: false, models: [], message: mapped.message, detail: mapped.detail }
    }
  })
  // 不抛异常：把中文结论与原始详情一并返回，界面两个都能显示。
  // 测的是「传进来的这条」——新建/编辑时可以先测再存。
  ipcMain.handle(IPC.settingsTest, async (_e, input: Provider) => {
    try {
      return await testConnection(validateProvider(input))
    } catch (err) {
      const mapped =
        err instanceof ChatError ? err : new ChatError(err instanceof Error ? err.message : String(err))
      return { ok: false, message: mapped.message, detail: mapped.detail }
    }
  })

  // 对话
  ipcMain.handle(IPC.convsList, (_e, cardId: string) => listConversations(cardId))
  ipcMain.handle(IPC.convsGet, async (_e, cardId: string, convId: string) =>
    (await getConversation(cardId, convId)) ?? null
  )
  ipcMain.handle(IPC.convsCreate, (_e, cardId: string) => createConv(cardId))
  ipcMain.handle(IPC.convsRename, (_e, cardId: string, convId: string, title: string) =>
    renameConversation(cardId, convId, title)
  )
  ipcMain.handle(IPC.convsDelete, (_e, cardId: string, convId: string) =>
    deleteConversation(cardId, convId)
  )
  // 消息级操作：一律先确认这条对话没在生成回复，否则刚删完又被追加回来
  ipcMain.handle(
    IPC.convsUpdateMessage,
    (_e, cardId: string, convId: string, messageId: string, content: string, dropAfter: boolean) => {
      guardIdle(cardId, convId)
      return updateMessage(cardId, convId, messageId, content, dropAfter === true)
    }
  )
  ipcMain.handle(
    IPC.convsDeleteMessage,
    (_e, cardId: string, convId: string, messageId: string, mode: DeleteMode) => {
      guardIdle(cardId, convId)
      return deleteMessage(cardId, convId, messageId, normalizeDeleteMode(mode))
    }
  )
  ipcMain.handle(
    IPC.convsRegenerate,
    (e, cardId: string, convId: string, messageId: string, opts: RegenerateOpts) =>
      regenerate(e.sender, cardId, convId, messageId, opts ?? {})
  )
  // 创建分支不查「正在回复中」：它只读原对话、往新对话里写，不会跟流式回复抢同一条记录
  ipcMain.handle(IPC.convsBranch, (_e, cardId: string, convId: string, messageId: string) =>
    branchConversation(cardId, convId, messageId)
  )

  // 剪贴板：走主进程而不是 navigator.clipboard（后者依赖文档焦点，会偶发不生效）
  // Electron 44 起 clipboard 是异步的，必须 await——否则渲染层的 await copyText() 会先于写入返回
  ipcMain.handle(IPC.copyText, async (_e, text: string) => {
    await clipboard.writeText(String(text ?? ''))
  })

  // 导入 / 导出（规范见 docs/tech.md §3「卡片的外部格式与导入映射」）
  ipcMain.handle(IPC.exportCard, (e, cardId: string) =>
    exportCard(BrowserWindow.fromWebContents(e.sender), cardId)
  )
  // 不抛异常：每张卡的结果（含失败原因）都写在报告里，一张失败不影响其余
  ipcMain.handle(IPC.importCards, (e) => importCards(BrowserWindow.fromWebContents(e.sender)))

  // 聊天
  ipcMain.handle(IPC.chatSend, (e, cardId: string, convId: string, text: string) =>
    sendChat(e.sender, cardId, convId, text)
  )
  ipcMain.handle(IPC.chatAbort, (_e, cardId: string, convId: string) => {
    abortStream(cardId, convId)
  })
}

// ---------- 头像 ----------

/** 选头像：对话框 → 校验扩展名与体积 → 复制进 avatars/ 并返回新文件名（不动卡片记录） */
async function pickAvatar(
  sender: Electron.WebContents,
  cardId: string
): Promise<{ avatar?: string }> {
  if (!isSafeAvatarName(cardId)) throw new Error('卡片标识不合法')

  const win = BrowserWindow.fromWebContents(sender)
  const options: Electron.OpenDialogOptions = {
    title: '选择头像图片',
    buttonLabel: '选择',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: AVATAR_EXTS }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return {}

  const src = result.filePaths[0]
  const ext = extname(src).slice(1).toLowerCase()
  if (!AVATAR_EXTS.includes(ext)) throw new Error('请选择 png / jpg / webp / gif 格式的图片')

  const info = await stat(src)
  if (info.size > MAX_AVATAR_BYTES) throw new Error('图片超过 5MB，请选择较小的图片')

  return { avatar: await copyAvatarFile(cardId, src, ext) }
}

// ---------- 设置校验 ----------

/** 设置落库前校验：温度 0–2、最大长度 1–131072。接口地址与 Key 已移到供应商，见 validateProvider */
function validateSettings(next: Settings): Settings {
  const temperature = Number(next.temperature)
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new Error('温度需要在 0 到 2 之间')
  }

  const maxTokens = Math.floor(Number(next.maxTokens))
  if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > 131072) {
    throw new Error('最大长度需要在 1 到 131072 之间')
  }

  return {
    temperature,
    maxTokens,
    // 只有显式传 false 才是非流式；缺省/垃圾值一律按流式（旧数据没有这个字段）
    stream: next.stream !== false,
    currentProviderId: (next.currentProviderId ?? '').trim()
  }
}

/** 供应商落库 / 测试前校验：地址必填，模型必填；Key 允许为空（能存不能测） */
function validateProvider(input: Provider): Provider {
  const baseUrl = (input?.baseUrl ?? '').trim()
  if (baseUrl === '') throw new Error('请填写接口地址')
  const model = (input?.model ?? '').trim()
  if (model === '') throw new Error('请填写模型名称')
  return {
    id: (input?.id ?? '').trim(),
    baseUrl,
    // 名称可空（'' = 界面显示接口地址）；旧数据没有这个字段，归一为 ''
    name: typeof input?.name === 'string' ? input.name.trim() : '',
    apiKey: (input?.apiKey ?? '').trim(),
    model,
    // 模型列表由「获取模型列表」拉好后随表单一起带进来；缺字段归一为「还没获取过」
    models: Array.isArray(input?.models)
      ? input.models.map((m) => (typeof m === 'string' ? m.trim() : '')).filter((m) => m !== '')
      : [],
    modelsFetchedAt: Number(input?.modelsFetchedAt) || 0,
    // 常用模型：缺字段归一为「没挑过」（聊天页照旧列全部）；只用于聊天页过滤，不参与请求
    commonModels: Array.isArray(input?.commonModels)
      ? input.commonModels.map((m) => (typeof m === 'string' ? m.trim() : '')).filter((m) => m !== '')
      : [],
    createdAt: Number(input?.createdAt) || Date.now(),
    updatedAt: Number(input?.updatedAt) || Date.now()
  }
}

// ---------- 对话 ----------

async function createConv(cardId: string): Promise<Conversation> {
  const card = getCard(cardId)
  if (!card) throw new Error('卡片不存在')
  return createConversation(card)
}

/** 消息级操作的前置检查：正在生成回复时不许动，否则刚删完又被追加回来 */
function guardIdle(cardId: string, convId: string): void {
  if (isStreaming(cardId, convId)) throw new Error('正在回复中，请稍候')
}

/** 渲染层传来的删除范围兜底（只信这三个值） */
function normalizeDeleteMode(mode: unknown): DeleteMode {
  return mode === 'reply-too' || mode === 'from-here' ? mode : 'only'
}

/** 「重新输出」的选项（渲染层传来，字段都不可信，用前逐个兜底） */
interface RegenerateOpts {
  /** true = 连这条之后的内容一起去掉；缺省/false = 只重写这一条 */
  dropAfter?: boolean
  /** 有值 = 先把这条的文字改成它，再重新请求（「改完自己发的话，让 AI 重新回答」） */
  content?: string
}

// ---------- 聊天 ----------

/** 进行中的回复任务：key = cardId:convId。退出前要等它们把半截回复写完 */
const sendJobs = new Map<string, Promise<void>>()

export function pendingStreamCount(): number {
  return sendJobs.size
}

/** 中止全部进行中的回复，并等待它们完成落盘（退出前调用） */
export function stopAllStreams(): Promise<void> {
  abortAllStreams()
  return Promise.allSettled([...sendJobs.values()]).then(() => undefined)
}

/** 取首条用户消息前 20 字作标题 */
function autoTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 20 ? `${clean.slice(0, 20)}…` : clean
}

/**
 * 发送一条消息：立即返回 {ok}，回复内容经 chat:event 推送。
 * 顺序：存用户消息（首条顺带定标题）→ 收录游玩历史 → 组装消息 → 后台跑流。
 */
async function sendChat(
  sender: Electron.WebContents,
  cardId: string,
  convId: string,
  text: string
): Promise<{ ok: boolean }> {
  const content = (text ?? '').trim()
  if (content === '') throw new Error('请输入内容')
  if (isStreaming(cardId, convId)) throw new Error('正在回复中，请稍候')

  const card = getCard(cardId)
  if (!card) throw new Error('卡片不存在')
  const conv = await getConversation(cardId, convId)
  if (!conv) throw new Error('对话不存在')

  const now = Date.now()
  const isFirstUserMessage = !conv.messages.some((m) => m.role === 'user')
  conv.messages.push({ id: randomUUID(), role: 'user', content, ts: now })
  if (isFirstUserMessage) conv.title = autoTitle(content)
  conv.updatedAt = now
  await saveConversation(conv)

  // 首次聊天自动收录进游玩历史；之后每次聊天更新最后游玩时间
  const meta = getMeta()
  const patch: Partial<MetaStore> = { lastPlayedAt: { ...meta.lastPlayedAt, [cardId]: now } }
  if (!meta.historyIds.includes(cardId)) patch.historyIds = [cardId, ...meta.historyIds]
  await updateMeta(patch)

  const messages: WireMessage[] = buildMessages(card, conv.messages.slice(0, -1), content)

  const { provider, model, stream, params } = resolveChatTarget(card)

  const key = streamKey(cardId, convId)
  const job = runStream(sender, cardId, convId, provider, params, model, stream, messages)
    .catch(() => {})
    .finally(() => sendJobs.delete(key))
  sendJobs.set(key, job)
  return { ok: true }
}

/**
 * 本次请求走哪条供应商、哪个模型、什么参数。
 * 每条消息现算，所以在状态条上改了模型/输出方式，下一条即生效。
 */
function resolveChatTarget(card: Card): {
  provider: Provider
  model: string
  stream: boolean
  params: { temperature: number; maxTokens: number }
} {
  const provider = getCurrentProvider()
  if (!provider) throw new Error('还没有配置供应商，请到「API 配置」里添加一个')
  if ((provider.apiKey ?? '').trim() === '') {
    throw new Error('当前供应商还没填 API Key，请到「API 配置」里填写')
  }
  const settings = getSettings()
  return {
    provider,
    // 生效模型：卡片指定 > 当前供应商的模型
    model: (card.model ?? '').trim() || provider.model,
    // stream 是布尔：false 是有效值，不能写成 settings.stream 的 falsy 回退
    stream: typeof card.stream === 'boolean' ? card.stream : settings.stream,
    // 生成参数：卡片指定 > 设置里的全局值。
    // 同样必须用 typeof 判断——0 是有效温度，真值判断会把「本卡设成 0」错当成「没设」
    params: {
      temperature: typeof card.temperature === 'number' ? card.temperature : settings.temperature,
      maxTokens: typeof card.maxTokens === 'number' ? card.maxTokens : settings.maxTokens
    }
  }
}

/**
 * 重新输出：去掉这条（或这条及之后）再请求一次。
 * 只改消息、不碰供应商的那些检查都放在前面——否则检查失败时消息已经被删了，用户白丢一条回复。
 */
async function regenerate(
  sender: Electron.WebContents,
  cardId: string,
  convId: string,
  messageId: string,
  opts: RegenerateOpts
): Promise<{ ok: boolean; insertAt: number }> {
  guardIdle(cardId, convId)

  const card = getCard(cardId)
  if (!card) throw new Error('卡片不存在')

  const { provider, model, stream, params } = resolveChatTarget(card)

  const { history, insertAt } = await prepareRegenerate(
    cardId,
    convId,
    messageId,
    typeof opts.content === 'string' ? opts.content : undefined,
    opts.dropAfter === true
  )

  // 重发没有新的用户输入，currentText 省略（不该凭空多出一条空的用户消息）
  const messages: WireMessage[] = buildMessages(card, history)

  const key = streamKey(cardId, convId)
  const job = runStream(sender, cardId, convId, provider, params, model, stream, messages, insertAt)
    .catch(() => {})
    .finally(() => sendJobs.delete(key))
  sendJobs.set(key, job)
  return { ok: true, insertAt }
}

/** 跑一条流：把增量推给界面，结束后落盘完整回复或半截回复 */
async function runStream(
  sender: Electron.WebContents,
  cardId: string,
  convId: string,
  provider: Provider,
  params: { temperature: number; maxTokens: number },
  model: string,
  stream: boolean,
  messages: WireMessage[],
  /** 新回复落在这个下标（重新输出的「只重写这条」）；缺省 = 追加到末尾 */
  insertAt?: number
): Promise<void> {
  const emit = (ev: ChatEvent): void => {
    if (!sender.isDestroyed()) sender.send(IPC.chatEvent, ev)
  }

  let acc = ''
  try {
    const result = await requestChat(
      cardId,
      convId,
      provider,
      params,
      model,
      stream,
      messages,
      (chunk) => {
        acc += chunk
        emit({ type: 'delta', cardId, convId, text: chunk })
      }
    )
    if (result.text !== '') acc = result.text

    if (!result.aborted && acc.trim() === '') {
      emit({
        type: 'error',
        cardId,
        convId,
        message: 'AI 没有返回内容，请稍后重试',
        detail: '接口返回了空的回复内容'
      })
      return
    }

    if (acc !== '') await appendAssistant(cardId, convId, acc, insertAt)
    emit(
      result.aborted
        ? { type: 'aborted', cardId, convId, partial: acc }
        : { type: 'done', cardId, convId, fullText: acc }
    )
  } catch (err) {
    const mapped =
      err instanceof ChatError
        ? err
        : new ChatError('回复失败', err instanceof Error ? err.message : String(err))

    // 出错前已经吐出来的部分也要留住，不让用户白等（半截回复同样落在该落的位置）
    if (acc !== '') await appendAssistant(cardId, convId, acc, insertAt).catch(() => {})
    emit({ type: 'error', cardId, convId, message: mapped.message, detail: mapped.detail })
  }
}

/**
 * 写入一条 assistant 消息；对话已被删除则丢弃。
 * `insertAt` 合法就插回那个位置（重新输出的「只重写这条」），否则追加到末尾。
 */
async function appendAssistant(
  cardId: string,
  convId: string,
  content: string,
  insertAt?: number
): Promise<void> {
  const conv = await getConversation(cardId, convId)
  if (!conv) return
  const at =
    typeof insertAt === 'number' && insertAt >= 0 && insertAt <= conv.messages.length
      ? insertAt
      : conv.messages.length
  const msg: ChatMessage = { id: randomUUID(), role: 'assistant', content, ts: Date.now() }
  conv.messages.splice(at, 0, msg)
  conv.updatedAt = Date.now()
  await saveConversation(conv)
}
