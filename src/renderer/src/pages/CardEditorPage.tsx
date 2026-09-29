// 卡片编辑页：名称 / 头像 / 开场白 / 角色设定 + 世界书条目管理 + 保存 / 删除卡片
import { useEffect, useState } from 'react'
import type { Card, WorldbookEntry } from '@shared/types'
import { providerLabel } from '@shared/types'
import { useAppStore } from '../store/appStore'
import { newId } from '../utils/format'
import Avatar from '../components/Avatar'
import ModelPicker, { type ModelGroup } from '../components/ModelPicker'
import WorldbookEntryModal from '../components/WorldbookEntryModal'
import { ArrowLeftIcon, ChevronDownIcon, ChevronUpIcon, EditIcon, ImageIcon, PlusIcon, TrashIcon } from '../components/icons'

interface Props {
  cardId?: string // 为空 = 新建
}

function emptyDraft(): Card {
  return {
    id: newId(), // 提前定好 id：头像文件名要用它做前缀
    name: '',
    systemPrompt: '',
    prePrompt: '',
    suffix: '',
    greeting: '',
    worldbook: [],
    createdAt: 0,
    updatedAt: 0
  }
}

/**
 * 可折叠的可选字段（前置词 / 后置词同款）。规范见 docs/design.md §4。
 * 默认收起——新手只看到「角色设定」一个框就够用；**本来就填过的卡展开**，别把内容藏起来。
 */
function OptionalField({
  label,
  collapsedHint,
  expandedHint,
  placeholder,
  value,
  onChange
}: {
  label: string
  collapsedHint: string
  expandedHint: string
  placeholder: string
  value: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(() => value.trim() !== '')
  const filled = value.trim().length

  return (
    <div className="field">
      <button type="button" className="field-collapse" onClick={() => setOpen((v) => !v)}>
        <ChevronDownIcon size={15} className={`field-collapse-arrow${open ? ' open' : ''}`} />
        <span className="field-label">{label}</span>
      </button>
      {open ? (
        <>
          <textarea
            className="field-textarea"
            rows={3}
            value={value}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
          <span className="field-hint">{expandedHint}</span>
        </>
      ) : (
        <span className="field-hint">
          {filled === 0 ? `${collapsedHint}。点上面展开。` : `已填写 ${filled} 字，点上面展开查看。`}
        </span>
      )}
    </div>
  )
}

export default function CardEditorPage({ cardId }: Props) {
  const cards = useAppStore((s) => s.cards)
  const goBack = useAppStore((s) => s.goBack)
  const refreshCards = useAppStore((s) => s.refreshCards)
  const refreshMeta = useAppStore((s) => s.refreshMeta)
  const toast = useAppStore((s) => s.toast)
  const askConfirm = useAppStore((s) => s.askConfirm)

  const original = cardId ? cards.find((c) => c.id === cardId) : undefined
  const isNew = original === undefined

  const [draft, setDraft] = useState<Card>(() =>
    original
      ? {
          ...original,
          // 按 order 排好序，界面顺序即注入顺序
          worldbook: [...original.worldbook].sort((a, b) => a.order - b.order).map((e) => ({ ...e }))
        }
      : emptyDraft()
  )
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  /** 前置词/后置词由各自的 OptionalField 自己管折叠态（本来就填过的会展开） */
  /** null = 未打开弹窗；{} = 新建；{ entry } = 编辑 */
  const [editing, setEditing] = useState<{ entry?: WorldbookEntry } | null>(null)
  /** 模型下拉的来源：当前使用中那条供应商的可用模型（没获取过时 ModelPicker 会退回兜底清单） */
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([])

  useEffect(() => {
    void (async () => {
      try {
        const [settings, list] = await Promise.all([
          window.api.settings.get(),
          window.api.providers.list()
        ])
        const current = list.find((p) => p.id === settings.currentProviderId)
        if (current) setModelGroups([{ label: providerLabel(current), models: current.models }])
      } catch {
        /* 读不到就用兜底清单 */
      }
    })()
  }, [])

  const patch = (changes: Partial<Card>) => {
    setDraft((d) => ({ ...d, ...changes }))
    setDirty(true)
  }

  // ---------- 头像 ----------

  const pickAvatar = async () => {
    try {
      const { avatar } = await window.api.cards.pickAvatar(draft.id)
      if (avatar) patch({ avatar })
    } catch (err) {
      toast(err instanceof Error ? err.message : '选择图片失败', 'error')
    }
  }

  // ---------- 世界书 ----------

  const setWorldbook = (list: WorldbookEntry[]) => {
    patch({ worldbook: list.map((e, i) => ({ ...e, order: i })) })
  }

  const saveEntry = (entry: WorldbookEntry) => {
    const list = draft.worldbook.slice()
    const idx = list.findIndex((e) => e.id === entry.id)
    if (idx >= 0) list[idx] = entry
    else list.push(entry)
    setWorldbook(list)
    setEditing(null)
  }

  const moveEntry = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= draft.worldbook.length) return
    const list = draft.worldbook.slice()
    ;[list[index], list[target]] = [list[target], list[index]]
    setWorldbook(list)
  }

  // ---------- 保存 / 删除 / 退出 ----------

  const handleSave = async () => {
    const name = draft.name.trim()
    if (name === '') {
      toast('请填写卡片名称', 'error')
      return
    }
    setSaving(true)
    try {
      await window.api.cards.save({ ...draft, name })
      await refreshCards()
      toast(isNew ? '已创建聊天卡' : '已保存')
      setDirty(false)
      goBack()
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = () => {
    askConfirm({
      title: '删除聊天卡',
      message: `确定删除卡片「${draft.name}」吗？其全部对话和头像将一并删除，不可恢复。`,
      confirmText: '删除',
      danger: true,
      onConfirm: async () => {
        try {
          await window.api.cards.delete(draft.id)
          await Promise.all([refreshCards(), refreshMeta()])
          toast('已删除')
          setDirty(false)
          goBack()
        } catch (err) {
          toast(err instanceof Error ? err.message : '删除失败', 'error')
        }
      }
    })
  }

  const handleBack = () => {
    if (!dirty) {
      goBack()
      return
    }
    askConfirm({
      title: '放弃修改？',
      message: '未保存的修改将丢失，确定退出吗？',
      confirmText: '退出',
      danger: true,
      onConfirm: goBack
    })
  }

  return (
    <div className="page">
      <header className="page-header">
        <button className="icon-btn" title="返回" onClick={handleBack}>
          <ArrowLeftIcon size={20} />
        </button>
        <h1 className="page-title">{isNew ? '新建聊天卡' : '编辑聊天卡'}</h1>
      </header>

      <div className="page-body">
        <section className="form-card">
          <div className="avatar-row">
            <Avatar card={draft} size={96} radius={16} />
            <div className="avatar-actions">
              <button className="btn" onClick={() => void pickAvatar()}>
                <ImageIcon size={18} /> 选择图片
              </button>
              {draft.avatar && (
                <button className="btn btn-ghost" onClick={() => patch({ avatar: undefined })}>
                  移除头像
                </button>
              )}
              <span className="field-hint">支持 png / jpg / webp / gif，不超过 5MB</span>
            </div>
          </div>

          <label className="field">
            <span className="field-label">名称</span>
            <input
              className="field-input"
              value={draft.name}
              maxLength={40}
              placeholder="例如：暖心助手小暖"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="field-label">开场白</span>
            <textarea
              className="field-textarea"
              rows={2}
              value={draft.greeting}
              placeholder="对话开始时角色说的第一句话，可留空"
              onChange={(e) => patch({ greeting: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="field-label">角色设定</span>
            <textarea
              className="field-textarea"
              rows={6}
              value={draft.systemPrompt}
              placeholder="告诉 AI 它是谁、怎么说话。例如：你是小暖，一个温柔耐心的生活助手…"
              onChange={(e) => patch({ systemPrompt: e.target.value })}
            />
            <span className="field-hint">这段会作为系统提示词发送，越具体角色越稳定。</span>
          </label>

          {/* 前置词 / 后置词：两个同款的可折叠字段，默认收起——「不懂就空着」。见 docs/design.md §4 */}
          <OptionalField
            label="前置词（可选）"
            collapsedHint="和角色设定同属人设，只是分两段写；不懂就空着"
            expandedHint="这段会排在角色设定前面一起发送。别人写的卡常常分成前置词和正文两段，导入时会自动填上。"
            placeholder="排在角色设定前面的一段话；不懂就空着"
            value={draft.prePrompt}
            onChange={(v) => patch({ prePrompt: v })}
          />

          <OptionalField
            label="后置词（可选）"
            collapsedHint="贴在 AI 回复前，管输出格式最有效；不懂就空着"
            expandedHint="这段会作为消息的最后一条发送。别人写的卡常常用到它，导入时会自动填上。"
            placeholder="紧贴着 AI 要回复的位置发送的一段话，用来约束文风与格式；不懂就空着"
            value={draft.suffix}
            onChange={(v) => patch({ suffix: v })}
          />

          <label className="field">
            <span className="field-label">模型（可选）</span>
            <ModelPicker
              value={draft.model ?? ''}
              onChange={(v) => patch({ model: v.trim() || undefined })}
              groups={modelGroups}
              emptyLabel="用默认模型"
            />
            <span className="field-hint">
              列表来自当前供应商；不选就用它的默认模型。想用别家的模型，先到「API 配置」或聊天页状态条把供应商切过去。
            </span>
          </label>
        </section>

        <section className="form-card">
          <div className="section-head">
            <div>
              <h2 className="section-title">世界书</h2>
              <span className="field-hint">对话中出现关键词时，自动把对应设定告诉 AI</span>
            </div>
            <button className="btn btn-sm" onClick={() => setEditing({})}>
              <PlusIcon size={16} /> 添加条目
            </button>
          </div>

          {draft.worldbook.length === 0 ? (
            <p className="field-hint">还没有世界书条目</p>
          ) : (
            <ul className="wb-list">
              {draft.worldbook.map((entry, index) => (
                <li key={entry.id} className="wb-row">
                  <div className="wb-main">
                    <div className="wb-title-row">
                      <span className="wb-title">{entry.title}</span>
                      {entry.alwaysOn && <span className="wb-badge">常驻</span>}
                    </div>
                    {entry.keywords.length > 0 && (
                      <div className="wb-chips">
                        {entry.keywords.map((k) => (
                          <span key={k} className="chip">
                            {k}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="wb-content">{entry.content}</div>
                  </div>
                  <div className="wb-actions">
                    <button
                      className="icon-btn"
                      title="上移"
                      disabled={index === 0}
                      onClick={() => moveEntry(index, -1)}
                    >
                      <ChevronUpIcon size={18} />
                    </button>
                    <button
                      className="icon-btn"
                      title="下移"
                      disabled={index === draft.worldbook.length - 1}
                      onClick={() => moveEntry(index, 1)}
                    >
                      <ChevronDownIcon size={18} />
                    </button>
                    <button className="icon-btn" title="编辑" onClick={() => setEditing({ entry })}>
                      <EditIcon size={18} />
                    </button>
                    <button
                      className="icon-btn danger"
                      title="删除条目"
                      onClick={() => setWorldbook(draft.worldbook.filter((e) => e.id !== entry.id))}
                    >
                      <TrashIcon size={18} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <footer className="page-footer">
        <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        {!isNew && (
          <button className="btn btn-danger-ghost" onClick={handleDelete}>
            <TrashIcon size={18} /> 删除卡片
          </button>
        )}
      </footer>

      {editing && (
        <WorldbookEntryModal
          entry={editing.entry}
          onCancel={() => setEditing(null)}
          onSave={saveEntry}
        />
      )}
    </div>
  )
}
