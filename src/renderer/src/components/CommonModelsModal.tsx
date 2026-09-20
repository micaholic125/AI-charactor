// 「挑常用模型」二级弹窗（挂在供应商表单里）：从拉回来的模型列表里勾几个常用的，
// 也能手打一个列表里没有的模型名。确定时才写回表单，取消/点遮罩都不写。
// 规范见 docs/design.md §4。
import { useMemo, useState } from 'react'
import Modal from './Modal'
import SearchBar from './SearchBar'
import { CheckIcon, PlusIcon } from './icons'

interface Props {
  /** 服务端拉回来的全量模型（已按字母序） */
  models: string[]
  /** 表单里当前的常用模型 */
  selected: string[]
  onCancel: () => void
  onConfirm: (next: string[]) => void
}

export default function CommonModelsModal({ models, selected, onCancel, onConfirm }: Props) {
  const [picked, setPicked] = useState<string[]>(selected)
  const [keyword, setKeyword] = useState('')
  const [draft, setDraft] = useState('')

  /**
   * 弹窗里的完整清单 = 拉回来的全部模型 + 已挑但列表里没有的（手填的、或已经下线的）。
   * 后者追加在末尾，挂「不在列表里」标签。
   */
  const rows = useMemo(() => {
    const extra = picked.filter((m) => !models.includes(m))
    return [
      ...models.map((m) => ({ model: m, missing: false })),
      ...extra.map((m) => ({ model: m, missing: true }))
    ]
  }, [models, picked])

  const kw = keyword.trim().toLowerCase()
  const shown = kw === '' ? rows : rows.filter((r) => r.model.toLowerCase().includes(kw))

  const toggle = (model: string) => {
    setPicked((list) => (list.includes(model) ? list.filter((m) => m !== model) : [...list, model]))
  }

  /** 手打一个列表外的模型名：已经在清单里的就只是打勾 */
  const addByHand = () => {
    const name = draft.trim()
    if (name === '') return
    setPicked((list) => (list.includes(name) ? list : [...list, name]))
    setDraft('')
  }

  return (
    <Modal
      title="挑常用模型"
      onClose={onCancel}
      width={520}
      footer={
        <>
          <button className="btn" onClick={() => setPicked([])} disabled={picked.length === 0}>
            清空
          </button>
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          {/* 勾选顺序会乱跳（手填的还得追加到末尾），统一按清单顺序存 */}
          <button className="btn btn-primary" onClick={() => onConfirm(rows.map((r) => r.model).filter((m) => picked.includes(m)))}>
            确定
          </button>
        </>
      }
    >
      <div className="field">
        <div className="cm-head">
          <SearchBar value={keyword} onChange={setKeyword} placeholder="搜索模型名" />
          <span className="field-hint">
            共 {models.length} 个模型 · 已选 {picked.length} 个
          </span>
        </div>

        {shown.length === 0 ? (
          <p className="search-empty">
            {rows.length === 0 ? '还没获取过模型列表，可以直接在下面手打模型名' : '没有找到匹配的模型'}
          </p>
        ) : (
          <div className="ms-items cm-list">
            {shown.map((r) => {
              const active = picked.includes(r.model)
              return (
                <button
                  key={r.model}
                  className={`ms-item${active ? ' active' : ''}`}
                  onClick={() => toggle(r.model)}
                >
                  <span className="ms-tick">{active && <CheckIcon size={15} />}</span>
                  <span className="ms-name">{r.model}</span>
                  {r.missing && <span className="ms-tag">不在列表里</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="field">
        <span className="field-label">列表里没有？直接填一个</span>
        <div className="input-with-btn">
          <input
            className="field-input"
            value={draft}
            placeholder="例如：deepseek-chat"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addByHand()
              }
            }}
          />
          <button className="btn btn-sm" onClick={addByHand} disabled={draft.trim() === ''}>
            <PlusIcon size={16} /> 添加
          </button>
        </div>
        <span className="field-hint">选中的模型，聊天页切换模型时会列在前面几个。</span>
      </div>
    </Modal>
  )
}
