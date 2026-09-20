// 双击「启动AI聊天卡.bat」时执行的启动脚本。
//
// 为什么中文提示写在这里而不是 .bat 里：cmd.exe 按系统默认代码页（中文系统是 GBK）
// 解析批处理文件内容，文件里若写 UTF-8 的中文会错位乱码、把脚本搅乱（实测过）。
// 批处理文件因此保持纯英文，中文提示交给 Node 输出。

import { spawn, execSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 5173

console.log('')
console.log('  ==========================================')
console.log('     AI聊天卡 正在启动，请稍等十几秒……')
console.log('  ==========================================')
console.log('')
console.log('  出现应用窗口后，这个黑色窗口请留在后台；')
console.log('  关掉它，应用就会一起退出。')
console.log('')

// 清理上次没退干净的残留进程：端口被占用的话，启动会失败
try {
  const out = execSync('netstat -ano', { encoding: 'utf8' })
  const pids = new Set()
  for (const line of out.split('\n')) {
    if (!line.includes('LISTENING') || !line.includes(`:${PORT} `)) continue
    const pid = line.trim().split(/\s+/).pop()
    if (pid && /^\d+$/.test(pid)) pids.add(pid)
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
      console.log(`  （已清理上次残留的进程 ${pid}）`)
    } catch {
      // 杀不掉就算了，交给 npm run dev 自己报错
    }
  }
  if (pids.size > 0) console.log('')
} catch {
  // netstat 用不了就跳过，不影响启动
}

const child = spawn('npm', ['run', 'dev'], { cwd: root, stdio: 'inherit', shell: true })

child.on('exit', (code) => {
  console.log('')
  if (code === 0 || code === null) {
    console.log('  应用已退出。')
  } else {
    console.log(`  应用异常退出（错误代码 ${code}）。`)
    console.log('  如果反复失败，把上面的报错内容发给 AI 助手看看。')
  }
  console.log('  按任意键关闭本窗口。')
})

child.on('error', (err) => {
  console.log('')
  console.log(`  启动失败：${err.message}`)
  console.log('  请确认已安装 Node.js（官网 https://nodejs.org ）。')
  console.log('  按任意键关闭本窗口。')
})
