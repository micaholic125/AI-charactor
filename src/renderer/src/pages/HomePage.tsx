// 主页：搜索 + 卡片网格（含「新建」卡片位）+ 收藏心形
import { useMemo, useState } from 'react'
import { useAppStore } from '../store/appStore'
import SearchBar from '../components/SearchBar'
import CardItem from '../components/CardItem'
import EmptyState from '../components/EmptyState'
import { ChatIcon, PlusIcon } from '../components/icons'

export default function HomePage() {
  const cards = useAppStore((s) => s.cards)
  const meta = useAppStore((s) => s.meta)
  const loaded = useAppStore((s) => s.loaded)
  const navigate = useAppStore((s) => s.navigate)
  const toggleFavorite = useAppStore((s) => s.toggleFavorite)
  const [query, setQuery] = useState('')

  const keyword = query.trim().toLowerCase()
  const filtered = useMemo(
    () => (keyword === '' ? cards : cards.filter((c) => c.name.toLowerCase().includes(keyword))),
    [cards, keyword]
  )

  return (
    <div className="page">
      <header className="page-header">
        <SearchBar value={query} onChange={setQuery} placeholder="搜索聊天卡" />
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
    </div>
  )
}
