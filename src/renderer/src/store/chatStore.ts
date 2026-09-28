// 聊天状态：当前对话的消息、流式回复（多对话可并行）、主进程事件订阅
//
// 数据流：消息以磁盘为准（主进程在 send 时就先落盘用户消息），
// 流式增量单独放在 streams 里即时渲染；done/aborted/error 到达后重读对话，
// 保证「流式气泡」与「落盘消息」无缝衔接。

import { create } from 'zustand'
import type { ChatEvent, ChatMessage } from '@shared/types'

/** 单条流的状态 */
export interface StreamState {
  text: string
  pending: boolean
  error?: { message: string; detail?: string }
  /**
   * 流式气泡该插在消息列表的哪个位置（「只重写这条」时它落在中间，不是末尾）。
   * 缺省 = 追加到最后。见 docs/design.md §4「消息操作条」。
   */
  at?: number
}

const keyOf = (cardId: string, convId: string): string => `${cardId}:${convId}`

interface ChatState {
  /** 当前打开的对话键；null = 不在聊天页 */
  key: string | null
  cardId: string
  convId: string
  title: string
  messages: ChatMessage[]
  loading: boolean
  /** 键 → 流状态。离开聊天页后仍保留，回到该对话能看到生成中的回复 */
  streams: Record<string, StreamState>

  /** 订阅主进程推送（幂等，App 挂载时调用一次） */
  subscribe: () => void
  open: (cardId: string, convId: string, silent?: boolean) => Promise<void>
  /** 重读当前对话（消息被改过 / 删过之后刷新界面用），不闪「正在加载」 */
  reload: () => Promise<void>
  close: () => void
  send: (text: string) => Promise<void>
  /** 重新输出（`dropAfter` 见 docs/tech.md §4）；失败时返回中文提示，成功返回 null */
  regenerate: (messageId: string, opts: { dropAfter: boolean; content?: string }) => Promise<string | null>
  abort: () => Promise<void>
}

let subscribed = false

export const useChatStore = create<ChatState>((set, get) => ({
  key: null,
  cardId: '',
  convId: '',
  title: '',
  messages: [],
  loading: false,
  streams: {},

  subscribe: () => {
    if (subscribed) return
    subscribed = true
    window.api.chat.onEvent((ev) => handleEvent(ev))
  },

  open: async (cardId, convId, silent = false) => {
    set({ key: keyOf(cardId, convId), cardId, convId, loading: !silent })
    try {
      const conv = await window.api.convs.get(cardId, convId)
      set({ messages: conv?.messages ?? [], title: conv?.title ?? '', loading: false })
    } catch {
      set({ messages: [], loading: false })
    }
  },

  reload: async () => {
    const { cardId, convId, key } = get()
    if (key === null || cardId === '' || convId === '') return
    try {
      const conv = await window.api.convs.get(cardId, convId)
      set({ messages: conv?.messages ?? [], title: conv?.title ?? '' })
    } catch {
      /* 读不到就维持现状，别把界面清空 */
    }
  },

  close: () => set({ key: null, cardId: '', convId: '', title: '', messages: [] }),

  send: async (text) => {
    const { cardId, convId } = get()
    const key = keyOf(cardId, convId)
    const content = text.trim()
    if (content === '' || cardId === '' || convId === '') return

    set((s) => ({ streams: { ...s.streams, [key]: { text: '', pending: true } } }))
    try {
      await window.api.chat.send(cardId, convId, content)
      // 用户消息已落盘，重读一次让气泡立刻出现（标题也可能刚自动生成）
      await get().open(cardId, convId, true)
    } catch (err) {
      const message = err instanceof Error ? err.message : '发送失败'
      set((s) => ({ streams: { ...s.streams, [key]: { text: '', pending: false, error: { message } } } }))
    }
  },

  regenerate: async (messageId, opts) => {
    const { cardId, convId, key } = get()
    if (key === null || cardId === '' || convId === '') return '对话不在'
    try {
      const res = await window.api.convs.regenerate(cardId, convId, messageId, opts)
      // 先把流式气泡挂上（带上它该落的位置），再重读对话——
      // 顺序反过来的话，中间的增量会先到，把 at 冲掉、气泡就跑到末尾去了
      set((s) => ({
        streams: { ...s.streams, [key]: { text: '', pending: true, at: res.insertAt } }
      }))
      await get().reload()
      return null
    } catch (err) {
      return err instanceof Error ? err.message : '重新输出失败'
    }
  },

  abort: async () => {
    const { cardId, convId } = get()
    if (cardId === '' || convId === '') return
    try {
      await window.api.chat.abort(cardId, convId)
    } catch {
      /* 已经结束了，忽略 */
    }
  }
}))

/**
 * 流结束后的收尾：重读对话（回复已落盘）+ 撤掉流式气泡。
 *
 * **两件事必须在同一个 set 里做完**。分开两次 set 会漏出一帧「新回复已经排版好、
 * 打字气泡却还在」的中间态——同一条回复显示两份（用 MutationObserver 逐帧抓到过）。
 * 两次 set 之间隔着一次 IPC 往返，谁都保证不了它们落在同一帧里。
 *
 * `error` 有值时保留流状态（只是清空文字、退掉 pending），好让错误横幅挂在气泡上方。
 */
async function settleStream(
  cardId: string,
  convId: string,
  key: string,
  error?: { message: string; detail?: string }
): Promise<void> {
  const isOpen = useChatStore.getState().key === key
  let messages: ChatMessage[] | null = null
  let title: string | null = null
  if (isOpen) {
    try {
      const conv = await window.api.convs.get(cardId, convId)
      messages = conv?.messages ?? []
      title = conv?.title ?? null
    } catch {
      /* 读不到就维持现状，别把界面清空 */
    }
  }

  useChatStore.setState((s) => {
    const streams = { ...s.streams }
    if (error) streams[key] = { text: '', pending: false, error }
    else delete streams[key]
    // 不是当前打开的对话：只动流状态，别去碰别人正在看的消息
    if (!isOpen) return { streams }
    return {
      messages: messages ?? s.messages,
      title: title ?? s.title,
      loading: false,
      streams
    }
  })
}

function handleEvent(ev: ChatEvent): void {
  const key = keyOf(ev.cardId, ev.convId)

  if (ev.type === 'delta') {
    useChatStore.setState((s) => ({
      streams: {
        ...s.streams,
        // at 要跟着走：它决定气泡渲染在哪一位，丢了气泡就跑到末尾去了
        [key]: { text: (s.streams[key]?.text ?? '') + ev.text, pending: true, at: s.streams[key]?.at }
      }
    }))
    return
  }

  // done / aborted：重读对话（AI 消息已落盘）与撤掉流式气泡一次做完，不留重叠帧
  if (ev.type === 'done' || ev.type === 'aborted') {
    void settleStream(ev.cardId, ev.convId, key)
    return
  }

  // error：半截文本同样已落盘，重读之后把错误提示挂上（失败原因给用户看）
  void settleStream(ev.cardId, ev.convId, key, { message: ev.message, detail: ev.detail })
}
