// 头像：有图显示图片（app-media 协议），无图显示色块 + 名字首字
import type { CSSProperties } from 'react'
import type { Card } from '@shared/types'
import { avatarColor, avatarUrl, firstChar } from '../utils/format'

interface Props {
  card: Pick<Card, 'id' | 'name' | 'avatar'>
  /** 固定边长（px）；不传则铺满父容器（fill 模式，用于网格卡片） */
  size?: number
  radius?: number
}

export default function Avatar({ card, size, radius = 12 }: Props) {
  const fill = size === undefined
  const className = `avatar${fill ? ' avatar-fill' : ''}${card.avatar ? '' : ' avatar-placeholder'}`
  const style: CSSProperties = fill
    ? { borderRadius: radius }
    : { width: size, height: size, borderRadius: radius }

  if (card.avatar) {
    return <img className={className} style={style} src={avatarUrl(card.avatar)} alt={card.name} draggable={false} />
  }

  return (
    <div
      className={className}
      style={{ ...style, background: avatarColor(card.id), fontSize: fill ? undefined : Math.round(size * 0.42) }}
    >
      {firstChar(card.name)}
    </div>
  )
}
