import { app, BrowserWindow, Menu, net, protocol } from 'electron'
import { basename, join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { access } from 'fs/promises'
import { ensureStore, getAvatarsDir, initStore } from './store'
import { ensureProviders } from './providers'
import { pendingStreamCount, registerIpc, stopAllStreams } from './ipc'
import { pendingMemoryJobCount, stopAllMemoryJobs } from './memoryService'

// 必须在 app ready 之前调用：重定向 userData 到 %APPDATA%\ai-chat-cards
initStore()

// 头像专用协议，必须在 app ready 之前注册为 privileged
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

/** 把 app-media://local/avatars/<文件名> 映射到 avatars 目录里的真实文件 */
async function handleAppMedia(request: Request): Promise<Response> {
  const avatarDir = resolve(getAvatarsDir())
  // 只取文件名：无论 URL 里写什么路径，都落不到 avatars 目录之外
  const name = basename(decodeURIComponent(new URL(request.url).pathname))
  const file = resolve(join(avatarDir, name))
  if (!file.startsWith(avatarDir)) return new Response('forbidden', { status: 403 })

  try {
    await access(file)
  } catch {
    return new Response('not found', { status: 404 })
  }
  return net.fetch(pathToFileURL(file).toString())
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 720,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'AI聊天卡',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // 安全：拒绝页面打开新窗口、拦截页面发起的跳转
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  // 开发模式加载 dev server，打包后加载本地文件
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  // 初始化存储：创建目录、写入种子数据、清理孤儿头像
  await ensureStore()
  // 初始化供应商配置：首次运行做旧数据迁移 / 预置一条
  await ensureProviders()
  protocol.handle('app-media', handleAppMedia)
  registerIpc()
  const win = createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 退出安全：正在回复/整理记忆时先中止，等半截回复与记忆落盘再真正退出
let quitting = false
app.on('before-quit', (e) => {
  if (quitting) return
  if (pendingStreamCount() === 0 && pendingMemoryJobCount() === 0) return
  quitting = true
  e.preventDefault()
  void Promise.allSettled([stopAllStreams(), stopAllMemoryJobs()]).finally(() => app.quit())
})
