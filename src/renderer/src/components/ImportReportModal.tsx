// 导入报告弹窗：逐张说清「装进来了什么 / 有什么没装进来」，并直接给「去编辑」入口。
// 规范见 docs/design.md §4「导入报告弹窗」。
//
// 两条要点：
//  · **不合并成一句「导入完成」**——用户要知道的恰恰是每张卡各自装进来了什么
//  · **报告要能转化成行动**——导进来的卡常常是空壳（平台没下发正文），用户手里若有内容，
//    得能顺手进编辑页补上，而不是自己「回主页 → 翻卡 → 点进去 → 点编辑」四五步
import type { ImportReport } from '@shared/types'
import Modal from './Modal'
import { EditIcon } from './icons'

interface Props {
  reports: ImportReport[]
  onClose: () => void
  /** 点某张卡的「去编辑」：关掉报告并进那张卡的编辑页 */
  onEdit: (cardId: string) => void
}

/** 一行要点：某项没有就不显示那一项 */
function summaryLine(r: ImportReport): string {
  const s = r.summary
  if (!s) return ''
  const parts: string[] = []
  if (s.promptChars > 0) parts.push(`角色设定 ${s.promptChars} 字`)
  if (s.suffixChars > 0) parts.push(`后置词 ${s.suffixChars} 字`)
  if (s.worldbookEntries > 0) parts.push(`世界书 ${s.worldbookEntries} 条`)
  if (s.hasGreeting) parts.push('有开场白')
  return parts.length > 0 ? parts.join(' · ') : '没有装进来任何正文内容'
}

export default function ImportReportModal({ reports, onClose, onEdit }: Props) {
  const okCount = reports.filter((r) => r.ok).length
  const failed = reports.length - okCount

  return (
    <Modal
      title="导入结果"
      onClose={onClose}
      width={560}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          知道了
        </button>
      }
    >
      <p className="import-report-head">
        {failed === 0
          ? `成功导入 ${okCount} 张卡。`
          : `成功 ${okCount} 张，失败 ${failed} 张。`}
      </p>

      <div className="import-report-list">
        {reports.map((r, i) => (
          <div key={`${r.fileName}-${i}`} className="import-report-item">
            <div className="import-report-row">
              <div className="import-report-text">
                <span className={`import-report-name${r.ok ? '' : ' bad'}`}>
                  {r.ok ? r.cardName || r.fileName : r.fileName}
                </span>
                <span className={`import-report-sum${r.ok ? '' : ' bad'}`}>
                  {r.ok ? summaryLine(r) : r.error}
                </span>
              </div>
              {r.ok && r.cardId !== undefined && (
                <button className="btn btn-sm" onClick={() => onEdit(r.cardId as string)}>
                  <EditIcon size={14} /> 去编辑
                </button>
              )}
            </div>
            {r.warnings.length > 0 && (
              <ul className="import-report-warn">
                {r.warnings.map((w, j) => (
                  <li key={j}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}
