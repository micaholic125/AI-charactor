// 圆角胶囊分段控件（我的收藏 / 游玩历史）
interface Option<T extends string> {
  value: T
  label: string
}

interface Props<T extends string> {
  value: T
  options: Array<Option<T>>
  onChange: (value: T) => void
}

export default function SegmentedControl<T extends string>({ value, options, onChange }: Props<T>) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={`segmented-item${o.value === value ? ' active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
