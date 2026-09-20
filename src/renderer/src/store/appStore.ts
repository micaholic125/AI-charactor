// 全局状态：导航（视图 + 返回栈）、卡片与元数据缓存、Toast、确认弹窗
import { create } from 'zustand'
import type { Card, MetaStore } from '@shared/types'
import { DEFAULT_META } from '@shared/types'

/** 视图联合类型：导航用状态机而非路由（桌面应用无需 URL） */
export type View =
  | { name: 'home' }
  | { name: 'mine' }
  | { name: 'apiConfig' } // API 配置：供应商列表（第三个底部栏目）
  | { name: 'cardDetail'; cardId: string } // 卡片详情：对话列表
  | { name: 'chat'; cardId: string; convId: string }
  | { name: 'settings' }
  | { name: 'editor'; cardId?: string } // cardId 为空 = 新建

export interface ToastItem {
  id: number
  text: string
  kind: 'ok' | 'error'
}

export interface ConfirmOptions {
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
  /**
   * 可选的第二个操作键，排在「取消」和「确定」中间。
   * 用在「后面已有的内容怎么办」这类必须二选一的场景（改消息 / 重新输出 / 删消息）——
   * 两个选择的后果都写在 message 里，别让用户在按钮文字里猜。见 docs/design.md §4。
   */
  altText?: string
  altDanger?: boolean
  onAlt?: () => void | Promise<void>
}

interface AppState {
  view: View
  stack: View[]
  cards: Card[]
  meta: MetaStore
  loaded: boolean
  toasts: ToastItem[]
  confirm: ConfirmOptions | null

  init: () => Promise<void>
  refreshCards: () => Promise<void>
  refreshMeta: () => Promise<void>
  /** 切页：tab 切换清空返回栈，其余情况把当前页压栈 */
  navigate: (view: View, options?: { replaceStack?: boolean }) => void
  goBack: () => void
  toggleFavorite: (cardId: string) => Promise<void>
  toast: (text: string, kind?: 'ok' | 'error') => void
  dismissToast: (id: number) => void
  askConfirm: (options: ConfirmOptions) => void
  closeConfirm: () => void
}

let toastSeq = 0

export const useAppStore = create<AppState>((set, get) => ({
  view: { name: 'home' },
  stack: [],
  cards: [],
  meta: { ...DEFAULT_META },
  loaded: false,
  toasts: [],
  confirm: null,

  init: async () => {
    try {
      const [cards, meta] = await Promise.all([window.api.cards.list(), window.api.meta.get()])
      set({ cards, meta, loaded: true })
    } catch (err) {
      set({ loaded: true })
      get().toast(err instanceof Error ? err.message : '数据加载失败', 'error')
    }
  },

  refreshCards: async () => {
    set({ cards: await window.api.cards.list() })
  },

  refreshMeta: async () => {
    set({ meta: await window.api.meta.get() })
  },

  navigate: (view, options) => {
    const { view: current, stack } = get()
    if (options?.replaceStack) {
      set({ view, stack: [] })
      return
    }
    set({ view, stack: [...stack, current] })
  },

  goBack: () => {
    const { stack } = get()
    if (stack.length === 0) {
      set({ view: { name: 'home' } })
      return
    }
    set({ view: stack[stack.length - 1], stack: stack.slice(0, -1) })
  },

  toggleFavorite: async (cardId) => {
    const { meta } = get()
    const isFav = meta.favoriteIds.includes(cardId)
    const patch: Partial<MetaStore> = isFav
      ? {
          favoriteIds: meta.favoriteIds.filter((id) => id !== cardId),
          // 取消收藏时连同收藏内的置顶一起去掉
          favoritePinnedIds: meta.favoritePinnedIds.filter((id) => id !== cardId)
        }
      : { favoriteIds: [...meta.favoriteIds, cardId] }

    set({ meta: { ...meta, ...patch } })
    try {
      set({ meta: await window.api.meta.update(patch) })
    } catch (err) {
      set({ meta }) // 失败回滚
      get().toast(err instanceof Error ? err.message : '操作失败', 'error')
    }
  },

  toast: (text, kind = 'ok') => {
    const id = ++toastSeq
    set({ toasts: [...get().toasts, { id, text, kind }] })
    setTimeout(() => get().dismissToast(id), 2500)
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  askConfirm: (options) => set({ confirm: options }),

  closeConfirm: () => set({ confirm: null })
}))
