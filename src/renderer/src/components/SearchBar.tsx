// 搜索框：圆角胶囊 + 搜索图标 + 一键清空；输入即过滤（过滤逻辑在调用方）
import { CloseIcon, SearchIcon } from './icons'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export default function SearchBar({ value, onChange, placeholder = '搜索' }: Props) {
  return (
    <div className="searchbar">
      <SearchIcon size={18} className="searchbar-icon" />
      <input
        className="searchbar-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {value !== '' && (
        <button className="searchbar-clear" title="清空" onClick={() => onChange('')}>
          <CloseIcon size={16} />
        </button>
      )}
    </div>
  )
}
