// 开发模式启动器：清除 ELECTRON_RUN_AS_NODE 后启动 electron-vite dev
// 背景：当前开发环境中存在 ELECTRON_RUN_AS_NODE=1（来源不明，非注册表/非 bash 配置），
// 会导致 electron.exe 以纯 Node 模式运行而无法启动应用。
// 用法：npm run dev

import { spawn } from 'node:child_process'
import { join } from 'node:path'

delete process.env.ELECTRON_RUN_AS_NODE

const cli = join(process.cwd(), 'node_modules', 'electron-vite', 'dist', 'cli.js')
const child = spawn(process.execPath, [cli, 'dev'], { stdio: 'inherit', env: process.env })

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('[dev] 启动失败:', err)
  process.exit(1)
})
