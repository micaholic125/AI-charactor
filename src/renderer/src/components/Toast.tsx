// 浮出提示：2.5 秒自动消失（计时在 appStore 里）
import { useAppStore } from '../store/appStore'
import { CheckIcon, CloseIcon } from './icons'

export default function ToastHost() {
  const toasts = useAppStore((s) => s.toasts)
  if (toasts.length === 0) return null

  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.kind === 'ok' ? <CheckIcon size={18} /> : <CloseIcon size={18} />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  )
}
