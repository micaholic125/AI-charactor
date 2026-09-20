// 确认弹窗（危险操作确认键用红色）；内容来自 appStore.confirm
import { useAppStore } from '../store/appStore'

export default function ConfirmHost() {
  const confirm = useAppStore((s) => s.confirm)
  const closeConfirm = useAppStore((s) => s.closeConfirm)
  if (!confirm) return null

  return (
    <div className="modal-overlay" onMouseDown={closeConfirm}>
      <div className="modal-panel confirm-panel" onMouseDown={(e) => e.stopPropagation()} role="dialog">
        <div className="confirm-title">{confirm.title}</div>
        <div className="confirm-message">{confirm.message}</div>
        <div className="confirm-actions">
          <button className="btn" onClick={closeConfirm}>
            取消
          </button>
          {confirm.altText && confirm.onAlt && (
            <button
              className={`btn ${confirm.altDanger ? 'btn-danger' : ''}`}
              onClick={() => {
                closeConfirm()
                void confirm.onAlt?.()
              }}
            >
              {confirm.altText}
            </button>
          )}
          <button
            className={`btn ${confirm.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => {
              closeConfirm()
              void confirm.onConfirm()
            }}
          >
            {confirm.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}
