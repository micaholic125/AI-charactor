// 卡片详情页：卡片信息 + 对话列表（新建 / 重命名 / 删除 / 进入聊天）
import { useCallback, useEffect, useState } from 'react'
import type { ConvSummary } from '@shared/types'
import { useAppStore } from '../store/appStore'
import { relativeTime } from '../utils/format'
import Avatar from '../components/Avatar'
import EmptyState from '../components/EmptyState'
import { ArrowLeftIcon, ChatIcon, EditIcon, PlusIcon, TrashIcon } from '../components/icons'

interface Props {
  cardId: string
}

export default function CardDetailPage({ cardId }: Props) {
  const card = useAppStore((s) => s.cards.find((c) => c.id === cardId))
  const goBack = useAppStore((s) => s.goBack)
  const navigate = useAppStore((s) => s.navigate)
  const toast = useAppStore((s) => s.toast)
  const askConfirm = useAppStore((s) => s.askConfirm)

  const [convs, setConvs] = useState<ConvSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  /** 正在行内重命名的对话 */
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)

  const load = useCallback(async () => {
    try {
      setConvs(await window.api.convs.list(cardId))
    } catch (err) {
      toast(err instanceof Error ? err.message : '对话列表加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [cardId, toast])

  useEffect(() => {
    void load()
  }, [load])

  const openChat = (convId: string) => navigate({ name: 'chat', cardId, convId })

  const handleNew = async () => {
    setCreating(true)
    try {
      const conv = await window.api.convs.create(cardId)
      openChat(conv.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : '新建对话失败', 'error')
    } finally {
      setCreating(false)
    }
  }

  const commitRename = async () => {
    const target = renaming
    if (!target) return
    setRenaming(null)
    const title = target.value.trim()
    const before = convs.find((c) => c.id === target.id)
    if (title === '' || (before && before.title === title)) return

    try {
      await window.api.convs.rename(cardId, target.id, title)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '重命名失败', 'error')
    }
  }

  const handleDelete = (conv: ConvSummary) => {
    askConfirm({
      title: '删除对话',
      message: `确定删除对话「${conv.title}」吗？其中的聊天记录将一并删除，不可恢复。`,
      confirmText: '删除',
      danger: true,
      onConfirm: async () => {
        try {
          await window.api.convs.delete(cardId, conv.id)
          await load()
          toast('已删除对话')
        } catch (err) {
          toast(err instanceof Error ? err.message : '删除失败', 'error')
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
        <Avatar card={card} size={40} radius={12} />
        <h1 className="page-title">{card.name}</h1>
        <button
          className="icon-btn"
          title="编辑聊天卡"
          onClick={() => navigate({ name: 'editor', cardId })}
        >
          <EditIcon size={20} />
        </button>
      </header>

      <div className="page-body">
        <button className="btn btn-primary btn-block" onClick={() => void handleNew()} disabled={creating}>
          <PlusIcon size={18} /> {creating ? '创建中…' : '新建对话'}
        </button>

        {!loading && convs.length === 0 && (
          <EmptyState
            icon={<ChatIcon size={40} />}
            text={'还没有对话\n点上面的「新建对话」开始聊天'}
          />
        )}

        <ul className="conv-list">
          {convs.map((conv) => (
            <li key={conv.id} className="conv-row">
              {renaming?.id === conv.id ? (
                <input
                  className="field-input conv-rename"
                  autoFocus
                  maxLength={30}
                  value={renaming.value}
                  onChange={(e) => setRenaming({ id: conv.id, value: e.target.value })}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              ) : (
                <button className="conv-main" onClick={() => openChat(conv.id)}>
                  <span className="conv-title">{conv.title}</span>
                  <span className="conv-meta">
                    {conv.branchFrom && `分支自 ${conv.branchFrom.title} · `}
                    {relativeTime(conv.updatedAt)} · {conv.messageCount} 条消息
                  </span>
                </button>
              )}
              <div className="conv-actions">
                <button
                  className="icon-btn"
                  title="重命名"
                  onClick={() => setRenaming({ id: conv.id, value: conv.title })}
                >
                  <EditIcon size={18} />
                </button>
                <button
                  className="icon-btn danger"
                  title="删除对话"
                  onClick={() => handleDelete(conv)}
                >
                  <TrashIcon size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
