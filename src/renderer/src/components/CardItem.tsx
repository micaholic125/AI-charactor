// 卡片网格单元：头像 + 名称 + 右上角心形收藏钮（点心形不触发跳转）
import type { Card } from '@shared/types'
import Avatar from './Avatar'
import { HeartIcon } from './icons'

interface Props {
  card: Card
  favorite: boolean
  onOpen: () => void
  onToggleFavorite: () => void
}

export default function CardItem({ card, favorite, onOpen, onToggleFavorite }: Props) {
  return (
    <div className="card-tile" onClick={onOpen} role="button" tabIndex={0}>
      <div className="card-tile-avatar">
        <Avatar card={card} />
        <button
          className={`card-tile-heart${favorite ? ' active' : ''}`}
          title={favorite ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
        >
          <HeartIcon size={20} filled={favorite} />
        </button>
      </div>
      <div className="card-tile-name" title={card.name}>
        {card.name}
      </div>
    </div>
  )
}
