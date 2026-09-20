// 本地模拟 API（OpenAI 兼容），仅用于开发期验证，不参与打包。
// 用法：node scripts/mock-api.mjs  [端口默认 8787]
//
// 支持的行为（靠请求里的 model 区分）：
//   deepseek-chat（默认）  正常流式回复，6 块
//   slow-model            慢速流式（40 块 × 100ms），用于验证「中途停止」
//   bad-model             返回 404（验证「接口地址或模型名称不正确」）
//   bad-request           返回 400 且带 error.message（验证透传）
//   any                   API Key 不是 test-key-* 开头（如 wrong-key）或缺失时返回 401
//
// 请求体 stream: false 时走非流式：整段 JSON 一次返回（slow-model 延迟 3 秒，
// 便于验证非流式下的「中途停止」）。仅非流式下生效：
//   bad-json              200 但返回 HTML（验证「接口返回的内容无法解析」）
//   empty-reply           200 但正文为空（验证「AI 没有返回内容」）
// 每次请求都会把收到的请求体写到临时目录，便于验证世界书注入。
// 文件名带端口号（mock-api-last-<端口>.json）：同时开两个实例时能分辨请求打到了哪一个。
//
// 另有 GET /v1/models（OpenAI 兼容的模型列表），用于验证「一键获取模型列表」：
//   返回 MOCK_MODELS，故意做成「乱序 + 有重复 + 混着不能聊天的条目」，
//   用来验证客户端会去重、排序、并滤掉 embedding / 语音 / 画图 / 重排。
//   两个实例的模型列表不同（端口 8787 多一个 port-a-only，8788 多一个 port-b-only），
//   便于验证「请求真的打到了新供应商」。

import { createServer } from 'http'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const PORT = Number(process.argv[2] ?? 8787)
const LAST_FILE = join(tmpdir(), `mock-api-last-${PORT}.json`)
const TEXT = '你好，我是小暖！这是一段用于验证流式输出的测试回复。'

/** 故意乱序 + 重复 + 掺杂非聊天模型，验证客户端的整理与过滤 */
const MOCK_MODELS = [
  'deepseek-reasoner',
  'text-embedding-3-small', // 非聊天，应被滤掉
  'deepseek-chat',
  'tts-1', // 非聊天，应被滤掉
  'whisper-1', // 非聊天，应被滤掉
  'deepseek-chat', // 重复，应去重
  'bge-reranker-v2-m3', // 非聊天，应被滤掉
  PORT === 8787 ? 'port-a-only' : 'port-b-only', // 两个实例各有一个专属模型
  'dall-e-3' // 非聊天，应被滤掉
]

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function chunkText(text, parts) {
  const size = Math.ceil(text.length / parts)
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/**
 * 接受任意 test-key-* 开头的 Key。
 * 这样自检时可以让两条供应商各用一把**不同**的 Key（test-key-aaa / test-key-bbb），
 * 从而验证「切换供应商后请求头里的 Key 真的换成了新那家的」。
 */
function validKey(req) {
  return /^Bearer test-key-/.test(req.headers.authorization ?? '')
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/_health') {
    sendJson(res, 200, { ok: true })
    return
  }

  // 模型列表（OpenAI 兼容）。与 chat/completions 一样校验 Key，便于验证「Key 不对」的提示
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    if (!validKey(req)) {
      sendJson(res, 401, { error: { message: 'Authentication Fails, Your api key is invalid' } })
      return
    }
    sendJson(res, 200, {
      object: 'list',
      data: MOCK_MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock' }))
    })
    return
  }

  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    sendJson(res, 404, { error: { message: 'Not Found' } })
    return
  }

  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { error: { message: '请求体不是合法 JSON' } })
      return
    }

    try {
      writeFileSync(LAST_FILE, JSON.stringify({ headers: req.headers, body }, null, 2), 'utf8')
    } catch {
      /* 写不进去不影响响应 */
    }

    if (!validKey(req)) {
      sendJson(res, 401, { error: { message: 'Authentication Fails, Your api key is invalid' } })
      return
    }

    if (body.model === 'bad-model') {
      sendJson(res, 404, { error: { message: 'The model `bad-model` does not exist' } })
      return
    }
    if (body.model === 'bad-request') {
      sendJson(res, 400, { error: { message: 'temperature 参数不合法' } })
      return
    }

    if (body.stream !== true) {
      // 只在非流式下生效的两个特殊模型（验证错误处理）
      if (body.model === 'bad-json') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body>502 Bad Gateway</body></html>')
        return
      }
      if (body.model === 'empty-reply') {
        sendJson(res, 200, {
          id: 'mock-1',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }]
        })
        return
      }

      const answer = () =>
        sendJson(res, 200, {
          id: 'mock-1',
          object: 'chat.completion',
          model: body.model,
          choices: [
            { index: 0, message: { role: 'assistant', content: TEXT }, finish_reason: 'stop' }
          ]
        })
      if (body.model !== 'slow-model') {
        answer()
        return
      }
      // 慢速非流式：等 3 秒再整段返回，期间可直接中止
      const timer = setTimeout(answer, 3000)
      res.on('close', () => clearTimeout(timer))
      return
    }

    const slow = body.model === 'slow-model'
    const pieces = slow ? chunkText(TEXT, 40) : chunkText(TEXT, 6)
    const gap = slow ? 100 : 40

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    let i = 0
    const timer = setInterval(() => {
      if (i >= pieces.length) {
        clearInterval(timer)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const payload = {
        id: 'mock-1',
        object: 'chat.completion.chunk',
        model: body.model,
        choices: [{ index: 0, delta: { content: pieces[i] }, finish_reason: null }]
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
      i += 1
    }, gap)

    // 注意：必须监听 res 的 close（req 的 close 在请求体读完就会触发，会误杀定时器）
    res.on('close', () => clearInterval(timer))
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-api] 已启动 http://127.0.0.1:${PORT}/v1`)
  console.log(`[mock-api] 最近请求记录：${LAST_FILE}`)
})
