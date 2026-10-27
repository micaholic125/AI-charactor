// 记忆区独立页：三层查看 / 增删改 / 清空 + 用量与整理进度。
// 规范见 requirements 3.9、docs/design.md §4「记忆页」。代码阶段 7.1。
import { useCallback, useEffect, useState } from 'react'
import type { ConversationMemory, MemoryLayer } from '@shared/types'
import { MEMORY_ENTRY_MAX, memoryChars, resolveMemoryConfig, totalMemoryChars } from '@shared/memory'
import { useAppStore } from '../store/appStore'
import { relativeTime } from '../utils/format'
import {
  ArrowLeftIcon,
  EditIcon,
  PlusIcon,
  TrashIcon
} from '../components/icons'

interface Props {
  cardId: string
  convId: string
}

interface LayerMeta {
  key: MemoryLayer
  title: string
  description: string
  emptyText: string
}

const LAYERS: LayerMeta[] = [
  {
    key: 'short',
    title: '短期记忆',
    description: '最近写进来的事实；超过上限后会自动整理进长期',
    emptyText: '还没有短期记忆。聊几句后 AI 会自动记录，也可以点「添加」自己写。'
  },
  {
    key: 'long',
    title: '长期记忆',
    description: '从短期整理出的故事与设定；超过上限后会自动整理进永久',
    emptyText: '还没有长期记忆。短期记忆满了会自动整理到这里。'
  },
  {
    key: 'permanent',
    title: '永久记忆',
    description: '长期保留的身份、关系与重大事件',
    emptyText: '还没有永久记忆。长期记忆满了会自动整理到这里。'
  }
]

interface EditState {
  layer: MemoryLayer
  entryId: string
  value: string
}

interface AddState {
  layer: MemoryLayer
  value: string
}

export default function MemoryPage({ cardId, convId }: Props) {
  const card = useAppStore((s) => s.cards.find((c) => c.id === cardId))
  const goBack = useAppStore((s) => s.goBack)
  const toast = useAppStore((s) => s.toast)
  const askConfirm = useAppStore((s) => s.askConfirm)

  const [memory, setMemory] = useState<ConversationMemory | null>(null)
  const [messageCount, setMessageCount] = useState(0)
  const [conversationTitle, setConversationTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<EditState | null>(null)
  const [adding, setAdding] = useState<AddState | null>(null)

  const load = useCallback(
    async (showLoading = false): Promise<void> => {
      if (showLoading) setLoading(true)
      try {
        const [view, conv] = await Promise.all([
          window.api.memory.get(cardId, convId),
          window.api.convs.get(cardId, convId)
        ])
        setMemory(view.memory)
        setMessageCount(view.messageCount)
        setBusy(view.busy)
        setConversationTitle(conv?.title ?? '')
      } catch (err) {
        toast(err instanceof Error ? err.message : '读取记忆失败', 'error')
      } finally {
        if (showLoading) setLoading(false)
      }
    },
    [cardId, convId, toast]
  )

  useEffect(() => {
    void load(true)
  }, [load])

  // 后台任务事件：整理中切 busy，结束时重读最新记忆与 lastError
  useEffect(() => {
    const off = window.api.memory.onEvent((ev) => {
      if (ev.cardId !== cardId || ev.convId !== convId) return
      if (ev.type === 'busy') {
        setBusy(ev.busy)
        if (!ev.busy) void load(false)
        return
      }
      void load(false)
    })
    return off
  }, [cardId, convId, load])

  const config = resolveMemoryConfig(card)
  const counts = {
    short: memory?.short.length ?? 0,
    long: memory?.long.length ?? 0,
    permanent: memory?.permanent.length ?? 0
  }
  const shortChars = memoryChars(memory?.short ?? [])
  const covered = Math.min(memory?.coveredCount ?? 0, messageCount)
  const uncovered = Math.max(0, messageCount - covered)

  // 超限提示（阶段 7.4）：达到沉淀阈值时告诉用户「下次会自动压缩」，永久层只提醒不自动裁剪
  const shortOver = counts.short >= config.shortBatch || shortChars > config.shortLimit
  const longOver = counts.long >= config.longBatch || counts.long > config.longLimit
  const permanentMany = counts.permanent > 20
  const totalChars = totalMemoryChars(memory ?? undefined)

  const apply = (next: ConversationMemory): void => setMemory(next)

  const addEntry = async (layer: MemoryLayer): Promise<void> => {
    if (!adding) return
    const text = adding.value.trim()
    if (text === '') {
      toast('记忆内容不能为空', 'error')
      return
    }
    try {
      apply(await window.api.memory.addEntry(cardId, convId, layer, text))
      setAdding(null)
      toast('已添加')
    } catch (err) {
      toast(err instanceof Error ? err.message : '添加失败', 'error')
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    const text = editing.value.trim()
    if (text === '') {
      toast('记忆内容不能为空', 'error')
      return
    }
    try {
      apply(
        await window.api.memory.updateEntry(
          cardId,
          convId,
          editing.layer,
          editing.entryId,
          text
        )
      )
      setEditing(null)
      toast('已保存')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    }
  }

  const removeEntry = (layer: MemoryLayer, entryId: string): void => {
    askConfirm({
      title: '删除这条记忆？',
      message: '删除后不可恢复；已经不再发送的旧原文也不会因此自动回来。',
      confirmText: '删除',
      danger: true,
      onConfirm: async () => {
        try {
          apply(await window.api.memory.deleteEntry(cardId, convId, layer, entryId))
          toast('已删除')
        } catch (err) {
          toast(err instanceof Error ? err.message : '删除失败', 'error')
        }
      }
    })
  }

  const clearLayer = (layer: MemoryLayer): void => {
    const meta = LAYERS.find((l) => l.key === layer)
    const count = counts[layer]
    askConfirm({
      title: `清空${meta?.title ?? '这一层'}？`,
      message: `这一层的 ${count} 条记忆会被删掉，且不会恢复；已经不再发送的旧原文也不会自动回来。`,
      confirmText: '清空',
      danger: true,
      onConfirm: async () => {
        try {
          apply(await window.api.memory.clearLayer(cardId, convId, layer))
          toast('已清空')
          setEditing(null)
          setAdding(null)
        } catch (err) {
          toast(err instanceof Error ? err.message : '清空失败', 'error')
        }
      }
    })
  }

  const organize = (mode: 'normal' | 'rebuild'): void => {
    const rebuild = mode === 'rebuild'
    askConfirm({
      title: rebuild ? '从头整理记忆？' : '现在整理记忆？',
      message: rebuild
        ? '会清空短期 / 长期 / 永久三层记忆，再按聊天记录重新整理；你手写的内容也会被覆盖，不可恢复。'
        : '会调用一次 AI 整理尚未写进记忆的消息，可能产生费用。',
      confirmText: rebuild ? '从头整理' : '开始整理',
      danger: rebuild,
      onConfirm: async () => {
        setBusy(true)
        try {
          await window.api.memory.organize(cardId, convId, mode)
          toast(rebuild ? '已开始从头整理' : '已开始整理')
        } catch (err) {
          setBusy(false)
          toast(err instanceof Error ? err.message : '整理失败', 'error')
        }
      }
    })
  }

  if (!card) {
    return (
      <div className="page">
        <header className="page-header">
          <button className="icon-btn" title="返回" onClick={goBack}>
            <ArrowLeftIcon size={20} />
          </button>
          <h1 className="page-title">聊天卡不存在</h1>
        </header>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header">
        <button className="icon-btn" title="返回" onClick={goBack}>
          <ArrowLeftIcon size={20} />
        </button>
        <div className="chat-head-text">
          <span className="page-title chat-head-name">记忆</span>
          <span className="chat-head-sub">
            {card.name}
            {conversationTitle ? ` · ${conversationTitle}` : ''}
          </span>
        </div>
      </header>

      <div className="page-body">
        {loading && memory === null ? (
          <p className="search-empty">正在加载…</p>
        ) : (
          <>
            <section className="form-card memory-status">
              <div className="memory-metrics">
                <div className="memory-metric">
                  <span className="memory-metric-label">短期</span>
                  <strong className="memory-metric-value">{counts.short} 条</strong>
                  <span className="field-hint">
                    {shortChars} / {config.shortLimit} 字
                  </span>
                </div>
                <div className="memory-metric">
                  <span className="memory-metric-label">长期</span>
                  <strong className="memory-metric-value">{counts.long} 条</strong>
                  <span className="field-hint">上限 {config.longLimit} 条</span>
                </div>
                <div className="memory-metric">
                  <span className="memory-metric-label">永久</span>
                  <strong className="memory-metric-value">{counts.permanent} 条</strong>
                  <span className="field-hint">不自动清理</span>
                </div>
              </div>
              <div className="field-hint">
                最近记录 {config.recentCount} 条（你与 AI 的消息各算一条）· 自动整理
                {config.enabled ? '开启' : '已关闭'}
              </div>
              <div className="memory-task-actions">
                <button
                  className="btn btn-sm"
                  disabled={busy || !config.enabled}
                  onClick={() => organize('normal')}
                >
                  {busy ? '正在整理…' : '现在整理一次'}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={busy || !config.enabled}
                  onClick={() => organize('rebuild')}
                >
                  从头整理
                </button>
                {busy && (
                  <span className="field-hint">AI 正在整理记忆，不会影响正常聊天</span>
                )}
              </div>
              {!config.enabled && (
                <div className="memory-banner">
                  这张卡关闭了记忆功能，AI 不会读写记忆；已有记忆仍然保留，重新开启后继续使用。
                </div>
              )}
              {memory?.lastError && (
                <div className="memory-banner memory-banner-error">
                  上次整理失败：{memory.lastError}（下次回复后会自动重试）
                </div>
              )}
            </section>

            {LAYERS.map((layer) => {
              const entries = memory?.[layer.key] ?? []
              const isAdding = adding?.layer === layer.key
              const isShort = layer.key === 'short'
              const isLong = layer.key === 'long'
              const overHint = !config.enabled
                ? ''
                : isShort && shortOver
                  ? '短期记忆已到整理上限，下次聊天后会自动压缩成一条长期记忆'
                  : isLong && longOver
                    ? '长期记忆已到整理上限，下次聊天后会自动压缩成一条永久记忆'
                    : !isShort && !isLong && permanentMany
                      ? '永久记忆超过 20 条了；这一层不会自动压缩，建议手动整理或删除一些'
                      : ''
              return (
                <section className="form-card" key={layer.key}>
                  <div className="section-head">
                    <div>
                      <h2 className="section-title">
                        {layer.title}
                        <span className="memory-count">
                          {isShort
                            ? `${entries.length} 条 · ${memoryChars(entries)} / ${config.shortLimit} 字`
                            : isLong
                              ? `${entries.length} / ${config.longLimit} 条`
                              : `${entries.length} 条`}
                        </span>
                      </h2>
                      <span className="field-hint">{layer.description}</span>
                    </div>
                    <div className="memory-head-actions">
                      {entries.length > 0 && (
                        <button
                          className="btn btn-sm btn-ghost"
                          disabled={busy}
                          onClick={() => clearLayer(layer.key)}
                        >
                          清空
                        </button>
                      )}
                      <button
                        className="btn btn-sm"
                        disabled={busy || isAdding}
                        onClick={() => {
                          setEditing(null)
                          setAdding({ layer: layer.key, value: '' })
                        }}
                      >
                        <PlusIcon size={16} /> 添加
                      </button>
                    </div>
                  </div>

                  {overHint !== '' && <div className="memory-banner">{overHint}</div>}

                  {isAdding && (
                    <div className="memory-editor">
                      <textarea
                        className="field-textarea"
                        rows={2}
                        maxLength={MEMORY_ENTRY_MAX}
                        value={adding.value}
                        placeholder="写一句想让 AI 记住的事…"
                        autoFocus
                        onChange={(e) =>
                          setAdding({ layer: layer.key, value: e.target.value })
                        }
                      />
                      <div className="memory-editor-actions">
                        <span className="field-hint">
                          {adding.value.length} / {MEMORY_ENTRY_MAX}
                        </span>
                        <button className="btn btn-sm btn-ghost" onClick={() => setAdding(null)}>
                          取消
                        </button>
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => void addEntry(layer.key)}
                        >
                          保存
                        </button>
                      </div>
                    </div>
                  )}

                  {entries.length === 0 && !isAdding ? (
                    <p className="field-hint">{layer.emptyText}</p>
                  ) : (
                    <ul className="memory-list">
                      {entries.map((entry) => {
                        const isEditing =
                          editing?.layer === layer.key && editing.entryId === entry.id
                        return (
                          <li className="memory-row" key={entry.id}>
                            {isEditing ? (
                              <div className="memory-editor">
                                <textarea
                                  className="field-textarea"
                                  rows={2}
                                  maxLength={MEMORY_ENTRY_MAX}
                                  value={editing.value}
                                  autoFocus
                                  onChange={(e) =>
                                    setEditing({
                                      layer: layer.key,
                                      entryId: entry.id,
                                      value: e.target.value
                                    })
                                  }
                                />
                                <div className="memory-editor-actions">
                                  <span className="field-hint">
                                    {editing.value.length} / {MEMORY_ENTRY_MAX}
                                  </span>
                                  <button
                                    className="btn btn-sm btn-ghost"
                                    onClick={() => setEditing(null)}
                                  >
                                    取消
                                  </button>
                                  <button
                                    className="btn btn-sm btn-primary"
                                    onClick={() => void saveEdit()}
                                  >
                                    保存
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="memory-main">
                                  <div className="memory-text">{entry.content}</div>
                                  <div className="memory-meta">
                                    {entry.source === 'user' ? '你写的' : 'AI 写的'}
                                    {entry.createdAt ? ` · ${relativeTime(entry.createdAt)}` : ''}
                                  </div>
                                </div>
                                <div className="memory-actions">
                                  <button
                                    className="icon-btn"
                                    title="修改"
                                    disabled={busy}
                                    onClick={() => {
                                      setAdding(null)
                                      setEditing({
                                        layer: layer.key,
                                        entryId: entry.id,
                                        value: entry.content
                                      })
                                    }}
                                  >
                                    <EditIcon size={16} />
                                  </button>
                                  <button
                                    className="icon-btn danger"
                                    title="删除"
                                    disabled={busy}
                                    onClick={() => removeEntry(layer.key, entry.id)}
                                  >
                                    <TrashIcon size={16} />
                                  </button>
                                </div>
                              </>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>
              )
            })}

            <p className="field-hint memory-progress">
              已整理到第 {covered} / {messageCount} 条消息 · AI 每次读最近{' '}
              {config.recentCount} 条原文
              {uncovered > 0 ? ` · 还有 ${uncovered} 条尚未写进记忆` : ''}
            </p>
            {totalChars > 12000 && (
              <p className="field-hint memory-progress">
                记忆较多（共 {totalChars} 字），小上下文模型可能放不下
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
