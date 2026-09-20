// 我的：我的收藏 / 游玩历史（置顶、移出、搜索）
// 注意：这里的「删除」只是移出列表，不会删除卡片本体（卡片本体在编辑页删）
import { useEffect, useMemo, useState } from 'react'
import type { Card } from '@shared/types'
import { useAppStore } from '../store/appStore'
import { relativeTime } from '../utils/format'
import Avatar from '../components/Avatar'
import SearchBar from '../components/SearchBar'
import SegmentedControl from '../components/SegmentedControl'
import EmptyState from '../components/EmptyState'
import { ChatIcon, HeartIcon, PinIcon, SettingsIcon, TrashIcon } from '../components/icons'

type Tab = 'fav' | 'history'

export default function MinePage() {
  const cards = useAppStore((s) => s.cards)
  const meta = useAppStore((s) => s.meta)
  const loaded = useAppStore((s) => s.loaded)
  const navigate = useAppStore((s) => s.navigate)
  const refreshMeta = useAppStore((s) => s.refreshMeta)
  const toast = useAppStore((s) => s.toast)
  const askConfirm = useAppStore((s) => s.askConfirm)

  const [tab, setTab] = useState<Tab>('fav')
  const [query, setQuery] = useState('')

  // 每次进入本页都刷新元数据：聊天时主进程会写入「游玩历史/最近游玩」，
  // 渲染层的缓存不会自己更新，不刷新的话历史列表会一直停在启动时的状态
  useEffect(() => {
    void refreshMeta()
  }, [refreshMeta])

  const isFav = tab === 'fav'
  const ids = isFav ? meta.favoriteIds : meta.historyIds
  const pinnedIds = isFav ? meta.favoritePinnedIds : meta.historyPinnedIds
  const keyword = query.trim().toLowerCase()

  const list = useMemo(() => {
    // 只显示还存在（未被删除）的卡片
    let items = ids
      .map((id) => cards.find((c) => c.id === id))
      .filter((c): c is Card => c !== undefined)

    if (keyword !== '') items = items.filter((c) => c.name.toLowerCase().includes(keyword))
    // 游玩历史按最近游玩倒序；收藏保持收录顺序
    if (!isFav) {
      items = [...items].sort(
        (a, b) => (meta.lastPlayedAt[b.id] ?? 0) - (meta.lastPlayedAt[a.id] ?? 0)
      )
    }
    // 置顶的一律排最前
    return [...items.filter((c) => pinnedIds.includes(c.id)), ...items.filter((c) => !pinnedIds.includes(c.id))]
  }, [ids, pinnedIds, cards, keyword, isFav, meta.lastPlayedAt])

  const togglePin = async (cardId: string) => {
    const next = pinnedIds.includes(cardId)
      ? pinnedIds.filter((id) => id !== cardId)
      : [...pinnedIds, cardId]
    const patch = isFav ? { favoritePinnedIds: next } : { historyPinnedIds: next }
    try {
      await window.api.meta.update(patch)
      await refreshMeta()
    } catch (err) {
      toast(err instanceof Error ? err.message : '置顶失败', 'error')
    }
  }

  const remove = (card: Card) => {
    askConfirm({
      title: isFav ? '移出收藏' : '移出游玩历史',
      message: isFav
        ? `确定将「${card.name}」移出收藏吗？（卡片不会被删除）`
        : `确定将「${card.name}」移出游玩历史吗？（卡片不会被删除）`,
      confirmText: '移出',
      danger: true,
      onConfirm: async () => {
        try {
          await window.api.meta.update(
            isFav
              ? {
                  favoriteIds: meta.favoriteIds.filter((id) => id !== card.id),
                  favoritePinnedIds: meta.favoritePinnedIds.filter((id) => id !== card.id)
                }
              : {
                  historyIds: meta.historyIds.filter((id) => id !== card.id),
                  historyPinnedIds: meta.historyPinnedIds.filter((id) => id !== card.id)
                }
          )
          await refreshMeta()
          toast('已移出列表')
        } catch (err) {
          toast(err instanceof Error ? err.message : '操作失败', 'error')
        }
      }
    })
  }

  const emptyText = isFav
    ? '还没有收藏\n在主页点卡片右上角的心形，就能收进这里'
    : '还没有游玩记录\n和任意一张卡聊一句，就会自动出现在这里'

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">我的</h1>
        <button className="icon-btn" title="设置" onClick={() => navigate({ name: 'settings' })}>
          <SettingsIcon size={20} />
        </button>
      </header>

      <div className="page-body">
        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={[
            { value: 'fav', label: '我的收藏' },
            { value: 'history', label: '游玩历史' }
          ]}
        />

        <div className="mine-search">
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder={isFav ? '搜索收藏' : '搜索历史'}
          />
        </div>

        {loaded && list.length === 0 && (
          <EmptyState
            icon={isFav ? <HeartIcon size={40} /> : <ChatIcon size={40} />}
            text={keyword !== '' ? `没有找到「${query.trim()}」相关的聊天卡` : emptyText}
          />
        )}

        <ul className="mine-list">
          {list.map((card) => (
            <li key={card.id} className="mine-row">
              <button
                className="mine-main"
                onClick={() => navigate({ name: 'cardDetail', cardId: card.id })}
              >
                <Avatar card={card} size={44} radius={12} />
                <span className="mine-text">
                  <span className="mine-name">{card.name}</span>
                  <span className="mine-sub">
                    {meta.lastPlayedAt[card.id]
                      ? `最近游玩：${relativeTime(meta.lastPlayedAt[card.id])}`
                      : isFav
                        ? '已收藏'
                        : ''}
                  </span>
                </span>
              </button>
              <div className="mine-actions">
                <button
                  className={`icon-btn${pinnedIds.includes(card.id) ? ' active' : ''}`}
                  title={pinnedIds.includes(card.id) ? '取消置顶' : '置顶'}
                  onClick={() => void togglePin(card.id)}
                >
                  <PinIcon size={18} filled={pinnedIds.includes(card.id)} />
                </button>
                <button className="icon-btn danger" title="移出列表" onClick={() => remove(card)}>
                  <TrashIcon size={18} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
