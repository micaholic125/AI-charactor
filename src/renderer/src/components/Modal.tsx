// 通用弹层：遮罩 + 圆角面板；点遮罩或关闭按钮收起
import type { ReactNode } from 'react'
import { CloseIcon } from './icons'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}

export default function Modal({ title, onClose, children, footer, width = 520 }: Props) {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal-panel"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
