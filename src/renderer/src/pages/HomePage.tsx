// 主页：搜索 + 卡片网格（含「新建」卡片位）+ 收藏心形 + 导入
import { useMemo, useState } from 'react'
import type { ImportReport } from '@shared/types'
import { useAppStore } from '../store/appStore'
import SearchBar from '../components/SearchBar'
import CardItem from '../components/CardItem'
import EmptyState from '../components/EmptyState'
import ImportReportModal from '../components/ImportReportModal'
import { ChatIcon, ImportIcon, PlusIcon } from '../components/icons'

export default function HomePage() {
  const cards = useAppStore((s) => s.cards)
  const meta = useAppStore((s) => s.meta)
  const loaded = useAppStore((s) => s.loaded)
  const navigate = useAppStore((s) => s.navigate)
  const toggleFavorite = useAppStore((s) => s.toggleFavorite)
  const refreshCards = useAppStore((s) => s.refreshCards)
  const toast = useAppStore((s) => s.toast)
  const [query, setQuery] = useState('')
  /** 导入报告；null = 没弹窗 */
  const [report, setReport] = useState<ImportReport[] | null>(null)
  const [importing, setImporting] = useState(false)

  const keyword = query.trim().toLowerCase()
  const filtered = useMemo(
    () => (keyword === '' ? cards : cards.filter((c) => c.name.toLowerCase().includes(keyword))),
    [cards, keyword]
  )

  /** 导入：选文件（可多选）→ 逐张识别转换落盘 → 弹报告。用户取消返回空数组，什么都不做 */
  const doImport = async () => {
    if (importing) return
    setImporting(true)
    try {
      const reports = await window.api.io.importCards()
      if (reports.length === 0) return
      await refreshCards()
      setReport(reports)
    } catch (err) {
      toast(err instanceof Error ? err.message : '导入失败', 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <SearchBar value={query} onChange={setQuery} placeholder="搜索聊天卡" />
        <button
          className="btn btn-sm"
          onClick={() => void doImport()}
          disabled={importing}
          title="从文件导入聊天卡（可一次选多个）"
        >
          <ImportIcon size={16} />
          {importing ? '导入中…' : '导入'}
        </button>
      </header>

      <div className="page-body">
        {loaded && cards.length === 0 ? (
          <EmptyState
            icon={<ChatIcon size={44} />}
            text={'还没有聊天卡，点下面的按钮创建第一张'}
            action={
              <button className="btn btn-primary" onClick={() => navigate({ name: 'editor' })}>
                <PlusIcon size={18} /> 新建聊天卡
              </button>
            }
          />
        ) : (
          <div className="card-grid">
            <button className="card-add" onClick={() => navigate({ name: 'editor' })}>
              <PlusIcon size={30} />
              <span>新建</span>
            </button>
            {filtered.map((card) => (
              <CardItem
                key={card.id}
                card={card}
                favorite={meta.favoriteIds.includes(card.id)}
                onOpen={() => navigate({ name: 'cardDetail', cardId: card.id })}
                onToggleFavorite={() => void toggleFavorite(card.id)}
              />
            ))}
          </div>
        )}

        {cards.length > 0 && filtered.length === 0 && (
          <p className="search-empty">没有找到「{query.trim()}」相关的聊天卡</p>
        )}
      </div>

      {report !== null && (
        <ImportReportModal
          reports={report}
          onClose={() => setReport(null)}
          onEdit={(cardId) => {
            setReport(null)
            navigate({ name: 'editor', cardId })
          }}
        />
      )}
    </div>
  )
}
