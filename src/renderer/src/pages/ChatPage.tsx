// 聊天页：气泡流 + 打字机式流式回复 + 中途停止 + 自动滚底 + 顶部状态条就地切换模型/输出方式
// 每条气泡悬停浮出操作条（修改 / 撤回 / 复制，AI 那边还有重新输出 / 删除），见 docs/design.md §4
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Card, ChatMessage, DeleteMode } from '@shared/types'
import { useAppStore } from '../store/appStore'
import { useChatStore } from '../store/chatStore'
import Avatar from '../components/Avatar'
import EmptyState from '../components/EmptyState'
import ChatSettingsBar from '../components/ChatSettingsBar'
import MarkdownText from '../components/MarkdownText'
import {
  ArrowLeftIcon,
  BookIcon,
  BranchIcon,
  ChatIcon,
  CopyIcon,
  EditIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
  TrashIcon,
  UndoIcon
} from '../components/icons'

interface Props {
  cardId: string
  convId: string
}

const BUSY_TIP = '正在回复中，稍等一下'

export default function ChatPage({ cardId, convId }: Props) {
  const card = useAppStore((s) => s.cards.find((c) => c.id === cardId))
  const goBack = useAppStore((s) => s.goBack)
  const navigate = useAppStore((s) => s.navigate)
  const refreshCards = useAppStore((s) => s.refreshCards)
  const toast = useAppStore((s) => s.toast)
  const askConfirm = useAppStore((s) => s.askConfirm)

  const title = useChatStore((s) => s.title)
  const messages = useChatStore((s) => s.messages)
  const memory = useChatStore((s) => s.memory)
  const loading = useChatStore((s) => s.loading)
  const stream = useChatStore((s) => s.streams[`${cardId}:${convId}`])
  const open = useChatStore((s) => s.open)
  const reload = useChatStore((s) => s.reload)
  const close = useChatStore((s) => s.close)
  const send = useChatStore((s) => s.send)
  const regenerate = useChatStore((s) => s.regenerate)
  const abort = useChatStore((s) => s.abort)

  const [draft, setDraft] = useState('')
  /** 正在就地编辑的消息（同时只会有一条） */
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** 用户是否贴在底部（翻看历史时不要把他拽回底部） */
  const stick = useRef(true)

  const pending = stream?.pending === true
  const streamText = stream?.text ?? ''
  /** 流式气泡落在第几位：「只重写这条」时在中间，缺省在末尾 */
  const streamAt = stream?.at ?? messages.length

  useEffect(() => {
    void open(cardId, convId)
    return () => close()
  }, [cardId, convId, open, close])

  // 切换对话时重新贴底，并退出可能残留的编辑态
  useEffect(() => {
    stick.current = true
    setEditing(null)
  }, [convId])

  // 新内容到达且用户贴在底部时滚到底
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, streamText, pending, loading, editing])

  // 输入框随内容长高（撤回把文字放回输入框时也要跟着长）
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [draft])

  const handleScroll = () => {
    const el = bodyRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  const doSend = async () => {
    const text = draft.trim()
    if (text === '' || pending) return
    setDraft('')
    stick.current = true
    await send(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void doSend()
    }
  }

  /**
   * 状态条改动：立刻写进卡片（下次发送即生效），并刷新缓存让界面回显。
   * 正在生成中的那条回复不受影响——它的请求早就发出去了。
   */
  const patchCard = async (patch: Partial<Card>) => {
    if (!card) return
    try {
      await window.api.cards.save({ ...card, ...patch })
      await refreshCards()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    }
  }

  // ---------- 消息操作 ----------

  /**
   * 改 / 删 / 重发了一条**已被记忆覆盖**的消息之后，问一句要不要顺手修正记忆。
   * 「只改原文」放最右（更安全、更常用），「一起整理记忆」多花一次请求。见 docs/design.md §4。
   */
  const askMemoryRefresh = (anchorIndex: number): void => {
    askConfirm({
      title: '这条消息已经写进记忆了',
      message:
        '「只改原文」记忆保持不变，AI 下次可能仍按旧记忆回答；' +
        '「一起整理记忆」会多调用一次 AI 修正记忆区。',
      altText: '一起整理记忆',
      onAlt: () => {
        void (async () => {
          try {
            await window.api.memory.refresh(cardId, convId, anchorIndex)
            toast('已开始按修改后的内容整理记忆')
          } catch (err) {
            toast(err instanceof Error ? err.message : '整理记忆失败', 'error')
          }
        })()
      },
      // 「只改原文」：什么都不用做，记忆保持原样
      onConfirm: () => {},
      confirmText: '只改原文'
    })
  }

  /** 目标消息在下标 `index`，且它已经被记忆接住了吗（要在操作前判断） */
  const isCovered = (index: number): boolean => index < (memory?.coveredCount ?? 0)

  /** 只改文字、不重新请求（AI 消息的「修改」、用户消息的「只改文字」都走这里） */
  const applyEdit = async (
    messageId: string,
    text: string,
    dropAfter: boolean,
    after?: () => void
  ) => {
    try {
      await window.api.convs.updateMessage(cardId, convId, messageId, text, dropAfter)
      await reload()
      toast('已修改')
      after?.()
    } catch (err) {
      toast(err instanceof Error ? err.message : '修改失败', 'error')
    }
  }

  /** 重新输出：成功时由 chatStore 挂上流式气泡，失败才在这里提示 */
  const doRegenerate = async (
    messageId: string,
    opts: { dropAfter: boolean; content?: string },
    after?: () => void
  ) => {
    const err = await regenerate(messageId, opts)
    if (err !== null) toast(err, 'error')
    else after?.()
  }

  const copyMessage = async (m: ChatMessage) => {
    try {
      await window.api.copyText(m.content)
      toast('已复制')
    } catch {
      toast('复制失败，请重试', 'error')
    }
  }

  const startEdit = (m: ChatMessage) => setEditing({ id: m.id, value: m.content })

  /**
   * 保存就地编辑。自己发的话还得问一句「后面已经聊过的怎么办」——
   * 两个选择的后果都写在弹窗正文里，别让用户从按钮文字里猜。见 docs/design.md §4。
   */
  const commitEdit = (m: ChatMessage, index: number) => {
    const cur = editing
    if (!cur || cur.id !== m.id) return
    const text = cur.value.trim()
    setEditing(null)
    // 空的或没改过：静默返回（沿用对话重命名那套手感）
    if (text === '' || text === m.content) return

    // 是否已被记忆覆盖要在改动前判断——改完 coveredCount 会跟着退
    const refreshAfter = isCovered(index) ? (): void => askMemoryRefresh(index) : undefined

    if (m.role === 'assistant') {
      void applyEdit(m.id, text, false, refreshAfter)
      return
    }

    const after = messages.length - index - 1
    if (after === 0) {
      askConfirm({
        title: '修改这条消息',
        message: '改完让 AI 重新回答。',
        confirmText: '重新回答',
        onConfirm: () => doRegenerate(m.id, { dropAfter: true, content: text }, refreshAfter)
      })
      return
    }
    askConfirm({
      title: '修改这条消息',
      message:
        `「重新回答」会让 AI 重新回复，后面的 ${after} 条消息一并删掉；` +
        '「只改文字」后面的消息原样保留，AI 不会重新回答。',
      altText: '只改文字',
      onAlt: () => applyEdit(m.id, text, false, refreshAfter),
      confirmText: '重新回答',
      danger: true,
      onConfirm: () => doRegenerate(m.id, { dropAfter: true, content: text }, refreshAfter)
    })
  }

  /** 撤回：删掉这条 + 紧随的 AI 回复，文字放回输入框 */
  const recallMessage = (m: ChatMessage, index: number) => {
    const refreshAfter = isCovered(index) ? (): void => askMemoryRefresh(index) : undefined
    askConfirm({
      title: '撤回这条消息',
      message: '确定撤回这条消息吗？它和 AI 的回复会一起删掉，文字会放回输入框。',
      confirmText: '撤回',
      danger: true,
      onConfirm: async () => {
        try {
          await window.api.convs.deleteMessage(cardId, convId, m.id, 'reply-too')
          setDraft(m.content)
          stick.current = true
          await reload()
          inputRef.current?.focus()
          toast('已撤回，改完可以重发')
          refreshAfter?.()
        } catch (err) {
          toast(err instanceof Error ? err.message : '撤回失败', 'error')
        }
      }
    })
  }

  const deleteMessage = (m: ChatMessage, index: number) => {
    const after = messages.length - index - 1
    const refreshAfter = isCovered(index) ? (): void => askMemoryRefresh(index) : undefined
    const doDelete = async (mode: DeleteMode) => {
      try {
        await window.api.convs.deleteMessage(cardId, convId, m.id, mode)
        await reload()
        toast('已删除')
        refreshAfter?.()
      } catch (err) {
        toast(err instanceof Error ? err.message : '删除失败', 'error')
      }
    }

    if (after === 0) {
      askConfirm({
        title: '删除这条消息',
        message: '它是最后一条消息，删掉后这一轮就没有回复了。',
        confirmText: '删除',
        danger: true,
        onConfirm: () => doDelete('only')
      })
      return
    }
    // 破坏性更大的那个放中间（红），不占「顺手就点了」的右侧位置
    askConfirm({
      title: '删除这条消息',
      message: `「只删这条」后面的消息原样保留；「这条及之后全删」会连同后面 ${after} 条一起删掉。`,
      altText: '这条及之后全删',
      altDanger: true,
      confirmText: '只删这条',
      onConfirm: () => doDelete('only'),
      onAlt: () => doDelete('from-here')
    })
  }

  /**
   * 创建分支：把到这条为止的内容复制成新对话，然后**直接进去接着聊**。
   * 返回键回到原对话（navigate 会把当前这页压进返回栈）。
   */
  const branchMessage = async (m: ChatMessage) => {
    try {
      const conv = await window.api.convs.branch(cardId, convId, m.id)
      toast('已创建分支')
      navigate({ name: 'chat', cardId, convId: conv.id })
    } catch (err) {
      toast(err instanceof Error ? err.message : '创建分支失败', 'error')
    }
  }

  const regenerateMessage = (m: ChatMessage, index: number) => {
    const after = messages.length - index - 1
    const refreshAfter = isCovered(index) ? (): void => askMemoryRefresh(index) : undefined
    if (after === 0) {
      askConfirm({
        title: '重新输出',
        message: '它是最后一条消息，重新输出会把它整个换掉。',
        confirmText: '重新输出',
        onConfirm: () => doRegenerate(m.id, { dropAfter: true }, refreshAfter)
      })
      return
    }
    askConfirm({
      title: '重新输出',
      message:
        `「删掉后面重来」会把这条 AI 回复和它后面的 ${after} 条消息一起删掉再重新生成；` +
        '「只重写这条」后面的消息原样保留。',
      altText: '只重写这条',
      onAlt: () => doRegenerate(m.id, { dropAfter: false }, refreshAfter),
      confirmText: '删掉后面重来',
      danger: true,
      onConfirm: () => doRegenerate(m.id, { dropAfter: true }, refreshAfter)
    })
  }

  // ---------- 渲染 ----------

  /** 流式气泡（打字中的点点 / 正在吐字的正文），插在 streamAt 那一位 */
  const streamNode =
    pending && streamText === '' ? (
      <div className="bubble-row">
        <div className="bubble bubble-ai bubble-typing">
          <i />
          <i />
          <i />
        </div>
      </div>
    ) : streamText !== '' ? (
      <div className="bubble-row">
        <div className="bubble bubble-ai">
          <span className="bubble-text">{streamText}</span>
          {pending && <span className="bubble-cursor" />}
        </div>
      </div>
    ) : null

  const renderMessage = (m: ChatMessage, i: number) => {
    const isUser = m.role === 'user'
    const editingThis = editing !== null && editing.id === m.id

    return (
      <div className={`bubble-row${isUser ? ' from-user' : ''}`}>
        <div className="bubble-wrap">
          {editingThis ? (
            <div className="msg-edit">
              <textarea
                className="field-textarea"
                autoFocus
                rows={3}
                value={editing ? editing.value : ''}
                onChange={(e) => setEditing({ id: m.id, value: e.target.value })}
                onKeyDown={(e) => {
                  // Enter 换行（消息是多行的），Esc 取消
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setEditing(null)
                  }
                }}
              />
              <div className="msg-edit-actions">
                <button className="btn" onClick={() => setEditing(null)}>
                  取消
                </button>
                <button className="btn btn-primary" onClick={() => commitEdit(m, i)}>
                  保存
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-ai'}`}>
                {isUser ? (
                  <span className="bubble-text">{m.content}</span>
                ) : (
                  // 只有已落盘的 AI 回复排版；用户消息照旧纯文本（见 docs/design.md §4）
                  <div className="bubble-text-md">
                    <MarkdownText content={m.content} />
                  </div>
                )}
              </div>
              {m.editedAt !== undefined && <span className="msg-edited">已修改</span>}
              <div className="msg-actions">
                {isUser ? (
                  <>
                    <button
                      className="msg-action"
                      disabled={pending}
                      title={pending ? BUSY_TIP : '修改这条消息'}
                      onClick={() => startEdit(m)}
                    >
                      <EditIcon size={14} />
                      修改
                    </button>
                    <button
                      className="msg-action msg-action-danger"
                      disabled={pending}
                      title={pending ? BUSY_TIP : '撤回这条消息'}
                      onClick={() => recallMessage(m, i)}
                    >
                      <UndoIcon size={14} />
                      撤回
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="msg-action"
                      disabled={pending}
                      title={pending ? BUSY_TIP : '从这条回复岔出去，另开一条对话接着聊'}
                      onClick={() => void branchMessage(m)}
                    >
                      <BranchIcon size={14} />
                      创建分支
                    </button>
                    <button
                      className="msg-action"
                      disabled={pending}
                      title={pending ? BUSY_TIP : '修改这条回复'}
                      onClick={() => startEdit(m)}
                    >
                      <EditIcon size={14} />
                      修改
                    </button>
                    <button
                      className="msg-action"
                      disabled={pending || i === 0}
                      title={
                        i === 0
                          ? '这是对话的第一条，前面没有内容可以让 AI 重新回答'
                          : pending
                            ? BUSY_TIP
                            : '重新生成这条回复'
                      }
                      onClick={() => regenerateMessage(m, i)}
                    >
                      <RefreshIcon size={14} />
                      重新输出
                    </button>
                    <button
                      className="msg-action msg-action-danger"
                      disabled={pending}
                      title={pending ? BUSY_TIP : '删除这条回复'}
                      onClick={() => deleteMessage(m, i)}
                    >
                      <TrashIcon size={14} />
                      删除
                    </button>
                  </>
                )}
                <button
                  className="msg-action"
                  disabled={pending}
                  title="复制到剪贴板"
                  onClick={() => void copyMessage(m)}
                >
                  <CopyIcon size={14} />
                  复制
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
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
      <header className="page-header chat-header">
        <button className="icon-btn" title="返回" onClick={goBack}>
          <ArrowLeftIcon size={20} />
        </button>
        <Avatar card={card} size={36} radius={10} />
        <div className="chat-head-text">
          <span className="page-title chat-head-name">{card.name}</span>
          <span className="chat-head-sub">{title || '对话'}</span>
        </div>
        <button
          className="icon-btn chat-memory-btn"
          title="记忆"
          onClick={() => navigate({ name: 'memory', cardId, convId })}
        >
          <BookIcon size={20} />
          {memory?.lastError && <span className="chat-memory-dot" />}
        </button>
      </header>

      <ChatSettingsBar card={card} onPatch={(patch) => void patchCard(patch)} />

      <div className="chat-body" ref={bodyRef} onScroll={handleScroll}>
        {loading && messages.length === 0 && <p className="search-empty">正在加载…</p>}

        {!loading && messages.length === 0 && !pending && (
          <EmptyState icon={<ChatIcon size={40} />} text="还没有消息，说点什么吧" />
        )}

        {messages.map((m, i) => (
          <Fragment key={m.id}>
            {streamAt === i && streamNode}
            {renderMessage(m, i)}
          </Fragment>
        ))}

        {streamAt >= messages.length && streamNode}

        {stream?.error && (
          <div className="chat-error">
            <span className="chat-error-msg">{stream.error.message}</span>
            {stream.error.detail && <span className="chat-error-detail">{stream.error.detail}</span>}
          </div>
        )}
      </div>

      <footer className="chat-input-bar">
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={1}
          value={draft}
          placeholder={pending ? '正在回复中…' : '说点什么…（Enter 发送，Shift+Enter 换行）'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {pending ? (
          <button className="btn btn-stop" onClick={() => void abort()} title="停止生成">
            <StopIcon size={18} /> 停止
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => void doSend()} disabled={draft.trim() === ''}>
            <SendIcon size={18} /> 发送
          </button>
        )}
      </footer>
    </div>
  )
}
