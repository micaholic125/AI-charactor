// 底部导航：主页 / 我的 / API 配置（激活态主色 + 实心图标）
import { useAppStore, type View } from '../store/appStore'
import { HomeIcon, PlugIcon, UserIcon } from './icons'

export default function TabBar() {
  const view = useAppStore((s) => s.view)
  const navigate = useAppStore((s) => s.navigate)

  const tabs: { key: View['name']; label: string; icon: typeof HomeIcon }[] = [
    { key: 'home', label: '主页', icon: HomeIcon },
    { key: 'mine', label: '我的', icon: UserIcon },
    { key: 'apiConfig', label: 'API 配置', icon: PlugIcon }
  ]

  return (
    <nav className="tabbar">
      {tabs.map(({ key, label, icon: IconCmp }) => {
        const active = view.name === key
        return (
          <button
            key={key}
            className={`tabbar-item${active ? ' active' : ''}`}
            onClick={() => navigate({ name: key } as View, { replaceStack: true })}
          >
            <IconCmp size={22} filled={active} />
            <span>{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
