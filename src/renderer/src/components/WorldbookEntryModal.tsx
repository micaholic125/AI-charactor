// 世界书条目编辑弹窗：标题 / 关键词（逗号分隔）/ 内容 / 常驻
import { useState } from 'react'
import type { WorldbookEntry } from '@shared/types'
import { useAppStore } from '../store/appStore'
import { newId } from '../utils/format'
import Modal from './Modal'

interface Props {
  /** 传入 = 编辑既有条目；不传 = 新建 */
  entry?: WorldbookEntry
  onCancel: () => void
  onSave: (entry: WorldbookEntry) => void
}

export default function WorldbookEntryModal({ entry, onCancel, onSave }: Props) {
  const toast = useAppStore((s) => s.toast)
  const [title, setTitle] = useState(entry?.title ?? '')
  const [keywords, setKeywords] = useState(entry?.keywords.join('，') ?? '')
  const [content, setContent] = useState(entry?.content ?? '')
  const [alwaysOn, setAlwaysOn] = useState(entry?.alwaysOn ?? false)

  const handleSave = () => {
    const text = content.trim()
    if (text === '') {
      toast('请填写条目内容', 'error')
      return
    }
    const list = keywords
      .split(/[,，]/)
      .map((k) => k.trim())
      .filter((k) => k !== '')
    if (!alwaysOn && list.length === 0) {
      toast('请填写触发关键词，或打开「常驻」', 'error')
      return
    }
    onSave({
      id: entry?.id ?? newId(),
      title: title.trim() === '' ? '未命名条目' : title.trim(),
      content: text,
      keywords: list,
      order: entry?.order ?? 0, // 顺序由编辑器统一重排
      alwaysOn
    })
  }

  return (
    <Modal
      title={entry ? '编辑世界书条目' : '添加世界书条目'}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            保存条目
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">标题</span>
        <input
          className="field-input"
          value={title}
          maxLength={30}
          placeholder="例如：雨天场景"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <label className="field">
        <span className="field-label">触发关键词</span>
        <input
          className="field-input"
          value={keywords}
          placeholder="用逗号分隔，例如：下雨，雨天，雨"
          onChange={(e) => setKeywords(e.target.value)}
        />
        <span className="field-hint">对话里出现任意一个词，这条设定就会告诉 AI。</span>
      </label>

      <label className="field">
        <span className="field-label">条目内容</span>
        <textarea
          className="field-textarea"
          rows={5}
          value={content}
          placeholder="要告诉 AI 的设定。例如：窗外细雨绵绵，空气里弥漫着潮湿的气息。"
          onChange={(e) => setContent(e.target.value)}
        />
      </label>

      <label className="switch-row">
        <input type="checkbox" checked={alwaysOn} onChange={(e) => setAlwaysOn(e.target.checked)} />
        <span>常驻：不需要关键词，每次对话都生效</span>
      </label>
    </Modal>
  )
}
