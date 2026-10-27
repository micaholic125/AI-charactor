// preload 桥接层：通过 contextBridge 只暴露白名单 API（契约见 docs/tech.md §4）
import { contextBridge, ipcRenderer } from 'electron'
import type {
  Api,
  Card,
  ChatEvent,
  Conversation,
  ConversationMemory,
  ConvSummary,
  DeleteMode,
  FetchModelsResult,
  ImportReport,
  MemoryEvent,
  MemoryLayer,
  MemoryOrganizeMode,
  MemoryView,
  MetaStore,
  Provider,
  Settings,
  TestResult
} from '@shared/types'
import { IPC } from '@shared/types'

/**
 * 统一 invoke：Electron 会把主进程抛的错误包成
 * "Error invoking remote method 'x': Error: 真正的中文提示"，
 * 这里剥掉包装，只把主进程写的那句中文交给界面显示。
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const marker = 'Error: '
    const idx = raw.lastIndexOf(marker)
    throw new Error(idx >= 0 ? raw.slice(idx + marker.length) : raw)
  }
}

const api: Api = {
  cards: {
    list: () => invoke<Card[]>(IPC.cardsList),
    save: (card: Card) => invoke<Card>(IPC.cardsSave, card),
    delete: (cardId: string) => invoke<void>(IPC.cardsDelete, cardId),
    pickAvatar: (cardId: string) => invoke<{ avatar?: string }>(IPC.avatarPick, cardId)
  },
  meta: {
    get: () => invoke<MetaStore>(IPC.metaGet),
    update: (patch: Partial<MetaStore>) => invoke<MetaStore>(IPC.metaUpdate, patch)
  },
  settings: {
    get: () => invoke<Settings>(IPC.settingsGet),
    save: (next: Settings) => invoke<Settings>(IPC.settingsSave, next),
    test: (provider: Provider) => invoke<TestResult>(IPC.settingsTest, provider)
  },
  providers: {
    list: () => invoke<Provider[]>(IPC.providersList),
    save: (provider: Provider) => invoke<Provider>(IPC.providersSave, provider),
    delete: (providerId: string) =>
      invoke<{ currentProviderId: string }>(IPC.providersDelete, providerId),
    setCurrent: (providerId: string) =>
      invoke<Settings>(IPC.providersSetCurrent, providerId),
    fetchModels: (provider: Provider) =>
      invoke<FetchModelsResult>(IPC.providersFetchModels, provider)
  },
  convs: {
    list: (cardId: string) => invoke<ConvSummary[]>(IPC.convsList, cardId),
    get: (cardId: string, convId: string) =>
      invoke<Conversation | null>(IPC.convsGet, cardId, convId),
    create: (cardId: string) => invoke<Conversation>(IPC.convsCreate, cardId),
    rename: (cardId: string, convId: string, title: string) =>
      invoke<Conversation>(IPC.convsRename, cardId, convId, title),
    delete: (cardId: string, convId: string) =>
      invoke<void>(IPC.convsDelete, cardId, convId),
    updateMessage: (
      cardId: string,
      convId: string,
      messageId: string,
      content: string,
      dropAfter: boolean
    ) => invoke<Conversation>(IPC.convsUpdateMessage, cardId, convId, messageId, content, dropAfter),
    deleteMessage: (cardId: string, convId: string, messageId: string, mode: DeleteMode) =>
      invoke<Conversation>(IPC.convsDeleteMessage, cardId, convId, messageId, mode),
    regenerate: (
      cardId: string,
      convId: string,
      messageId: string,
      opts?: { dropAfter?: boolean; content?: string }
    ) =>
      invoke<{ ok: boolean; insertAt: number }>(
        IPC.convsRegenerate,
        cardId,
        convId,
        messageId,
        opts ?? {}
      ),
    branch: (cardId: string, convId: string, messageId: string) =>
      invoke<Conversation>(IPC.convsBranch, cardId, convId, messageId)
  },
  memory: {
    get: (cardId: string, convId: string) =>
      invoke<MemoryView>(IPC.memoryGet, cardId, convId),
    addEntry: (cardId: string, convId: string, layer: MemoryLayer, content: string) =>
      invoke<ConversationMemory>(IPC.memoryAddEntry, cardId, convId, layer, content),
    updateEntry: (
      cardId: string,
      convId: string,
      layer: MemoryLayer,
      entryId: string,
      content: string
    ) =>
      invoke<ConversationMemory>(
        IPC.memoryUpdateEntry,
        cardId,
        convId,
        layer,
        entryId,
        content
      ),
    deleteEntry: (cardId: string, convId: string, layer: MemoryLayer, entryId: string) =>
      invoke<ConversationMemory>(
        IPC.memoryDeleteEntry,
        cardId,
        convId,
        layer,
        entryId
      ),
    clearLayer: (cardId: string, convId: string, layer: MemoryLayer) =>
      invoke<ConversationMemory>(IPC.memoryClearLayer, cardId, convId, layer),
    organize: (cardId: string, convId: string, mode?: MemoryOrganizeMode) =>
      invoke<{ ok: boolean }>(IPC.memoryOrganize, cardId, convId, mode ?? 'normal'),
    onEvent: (cb: (ev: MemoryEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: MemoryEvent): void => cb(ev)
      ipcRenderer.on(IPC.memoryEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.memoryEvent, listener)
      }
    }
  },
  chat: {
    send: (cardId: string, convId: string, text: string) =>
      invoke<{ ok: boolean }>(IPC.chatSend, cardId, convId, text),
    abort: (cardId: string, convId: string) => invoke<void>(IPC.chatAbort, cardId, convId),
    onEvent: (cb: (ev: ChatEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: ChatEvent): void => cb(ev)
      ipcRenderer.on(IPC.chatEvent, listener)
      return () => {
        ipcRenderer.removeListener(IPC.chatEvent, listener)
      }
    }
  },
  io: {
    exportCard: (cardId: string) => invoke<{ path: string | null }>(IPC.exportCard, cardId),
    // 不抛异常：失败写在每张卡的报告里
    importCards: () => invoke<ImportReport[]>(IPC.importCards)
  },
  copyText: (text: string) => invoke<void>(IPC.copyText, text)
}

contextBridge.exposeInMainWorld('api', api)
