// 界面小工具：相对时间、头像配色、文件名 → app-media 地址

/** 生成一个足够唯一的字符串 id（卡片新建时用，头像文件名前缀依赖它） */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / n 天前 / M月D日 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  if (!ts) return ''
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`

  const dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  if (dayDiff <= 0) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (dayDiff === 1) return '昨天'
  if (dayDiff < 7) return `${dayDiff} 天前`

  const d = new Date(ts)
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()} 年 `
  return `${year}${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 头像占位色板（8 色），按卡片 id 哈希取模，保证同一张卡颜色稳定 */
const AVATAR_COLORS = [
  '#4C6FFF',
  '#7C5CFF',
  '#C05CE8',
  '#E85C8A',
  '#F2994A',
  '#22A06B',
  '#12A5B8',
  '#5B6BFF'
]

export function avatarColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

/** 占位头像上的首字（中文取第一个字，兼容 emoji） */
export function firstChar(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return '卡'
  return Array.from(trimmed)[0]
}

/** 头像文件名 → 渲染层可直接用的地址（主进程 app-media 协议负责寻址与防穿越） */
export function avatarUrl(fileName: string): string {
  return `app-media://local/avatars/${encodeURIComponent(fileName)}`
}

/** 卡片名截断（列表/标题用） */
export function truncate(text: string, max = 20): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}
