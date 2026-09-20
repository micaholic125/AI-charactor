// 模型选择器：下拉列出「传进来的模型列表」（按来源分组），列表外的模型走「自定义…」手填。
// 模型列表来自「获取模型列表」从服务商拉回来的结果（见 docs/tech.md §3）；
// 一条都还没获取过时退回 FALLBACK_MODELS，免得下拉是空的。
// 规范见 docs/design.md §4。传 emptyLabel 时多一个空选项（编辑页「用默认模型」）。
import { useState } from 'react'
import { FALLBACK_MODELS } from '@shared/types'

const CUSTOM = '__custom__'

/** 一组可选的模型（label 一般是供应商接口地址） */
export interface ModelGroup {
  label: string
  models: string[]
}

interface Props {
  value: string
  onChange: (value: string) => void
  /** 可选的模型分组；为空则用内置兜底清单 */
  groups?: ModelGroup[]
  /** 空选项的文案（编辑页：'用默认模型'）；不传则没有空选项 */
  emptyLabel?: string
}

export default function ModelPicker({ value, onChange, groups, emptyLabel }: Props) {
  // 一个模型都没拉到过：退回兜底清单，至少让用户能选
  const effective: ModelGroup[] =
    groups && groups.some((g) => g.models.length > 0)
      ? groups.filter((g) => g.models.length > 0)
      : [{ label: '常见模型', models: FALLBACK_MODELS }]

  const all = effective.flatMap((g) => g.models)
  const inList = value !== '' && all.includes(value)
  const isCustom = value !== '' && !inList
  /** 用户点了「自定义…」：即使值还是列表里的模型，也进入自定义模式（旧值预填进输入框） */
  const [customOpen, setCustomOpen] = useState(isCustom)

  const inCustomMode = isCustom || customOpen
  const mode = inCustomMode ? CUSTOM : value
  const showInput = inCustomMode

  return (
    <div className="model-picker">
      <select
        className="field-input model-select"
        value={mode}
        onChange={(e) => {
          const v = e.target.value
          if (v === '') {
            setCustomOpen(false)
            onChange('')
            return
          }
          if (v === CUSTOM) {
            setCustomOpen(true) // 值不变，等用户输入
            return
          }
          setCustomOpen(false)
          onChange(v)
        }}
      >
        {emptyLabel && <option value="">{emptyLabel}</option>}
        {!emptyLabel && mode === '' && <option value="">请选择模型</option>}
        {effective.map((group, i) =>
          // 只有一组时不必套分组标题，免得下拉里多一层没意义的缩进
          effective.length === 1 ? (
            group.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))
          ) : (
            <optgroup key={`${group.label}-${i}`} label={group.label}>
              {group.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </optgroup>
          )
        )}
        <option value={CUSTOM}>自定义…</option>
      </select>

      {showInput && (
        <input
          className="field-input model-input"
          value={value}
          placeholder="输入模型名称，例如 deepseek-chat"
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value
            // 输入的内容正好是列表里的模型时退出自定义模式，下拉自动跳回该模型
            if (v !== '' && all.includes(v)) setCustomOpen(false)
            onChange(v)
          }}
        />
      )}
    </div>
  )
}
