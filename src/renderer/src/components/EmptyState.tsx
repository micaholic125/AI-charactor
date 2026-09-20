// 空状态：居中图标 + 一句引导文案（可带操作按钮）
import type { ReactNode } from 'react'

interface Props {
  icon?: ReactNode
  text: string
  action?: ReactNode
}

export default function EmptyState({ icon, text, action }: Props) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-text">{text}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}
