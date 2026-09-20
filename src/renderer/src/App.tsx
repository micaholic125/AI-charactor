// 应用外壳：视图切换 + 底部导航 + Toast / 确认弹窗宿主 + 聊天事件订阅
import { useEffect } from 'react'
import { useAppStore } from './store/appStore'
import { useChatStore } from './store/chatStore'
import TabBar from './components/TabBar'
import ToastHost from './components/Toast'
import ConfirmHost from './components/ConfirmDialog'
import HomePage from './pages/HomePage'
import MinePage from './pages/MinePage'
import CardDetailPage from './pages/CardDetailPage'
import ChatPage from './pages/ChatPage'
import CardEditorPage from './pages/CardEditorPage'
import SettingsPage from './pages/SettingsPage'
import ProviderPage from './pages/ProviderPage'

function ViewRouter() {
  const view = useAppStore((s) => s.view)

  switch (view.name) {
    case 'home':
      return <HomePage />
    case 'mine':
      return <MinePage />
    case 'apiConfig':
      return <ProviderPage />
    case 'cardDetail':
      return <CardDetailPage key={view.cardId} cardId={view.cardId} />
    case 'chat':
      return <ChatPage key={`${view.cardId}:${view.convId}`} cardId={view.cardId} convId={view.convId} />
    case 'settings':
      return <SettingsPage />
    case 'editor':
      // key 保证换卡片时编辑器重新取初始值
      return <CardEditorPage key={view.cardId ?? 'new'} cardId={view.cardId} />
  }
}

export default function App() {
  const view = useAppStore((s) => s.view)
  const init = useAppStore((s) => s.init)
  const subscribeChat = useChatStore((s) => s.subscribe)

  useEffect(() => {
    void init()
  }, [init])

  // 只订阅一次：主进程推送的流式事件进 chatStore，切换页面也不丢
  useEffect(() => {
    subscribeChat()
  }, [subscribeChat])

  const showTabBar = view.name === 'home' || view.name === 'mine' || view.name === 'apiConfig'

  return (
    <div className="app-shell">
      <main className="app-main">
        <ViewRouter />
      </main>
      {showTabBar && <TabBar />}
      <ToastHost />
      <ConfirmHost />
    </div>
  )
}
