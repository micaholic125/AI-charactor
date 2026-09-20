// 生成应用图标 build/icon.png（512×512，零依赖，仅 Node 内置模块）
// 设计：主色圆角底 + 白色聊天气泡 + 三个主色圆点
// 用法：node scripts/gen-icon.mjs

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 512
const PRIMARY = [76, 111, 255] // #4C6FFF
const WHITE = [255, 255, 255]

// ---- PNG 工具 ----
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// ---- 几何判断 ----
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.max(x0 + r, Math.min(x, x1 - r))
  const cy = Math.max(y0 + r, Math.min(y, y1 - r))
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r)
}
function inCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
function inTriangle(x, y, a, b, c) {
  const s = (p1, p2, p) => (p1[0] - p[0]) * (p2[1] - p[1]) - (p1[1] - p[1]) * (p2[0] - p[0])
  const d1 = s(a, b, [x, y]), d2 = s(b, c, [x, y]), d3 = s(c, a, [x, y])
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

// ---- 绘制（逐像素） ----
const bg = { x0: 8, y0: 8, x1: SIZE - 8, y1: SIZE - 8, r: 96 }
const bubble = { x0: 96, y0: 132, x1: 416, y1: 316, r: 44 }
const tail = { a: [170, 310], b: [262, 310], c: [148, 388] }
const dots = [
  { cx: 176, cy: 224 }, { cx: 256, cy: 224 }, { cx: 336, cy: 224 }
]
const dotR = 26

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1)
  raw[rowStart] = 0 // filter: None
  for (let x = 0; x < SIZE; x++) {
    const p = rowStart + 1 + x * 4
    let color = null
    const isBubble = inRoundedRect(x, y, bubble.x0, bubble.y0, bubble.x1, bubble.y1, bubble.r) ||
      (x >= bubble.x0 && x <= bubble.x1 && inTriangle(x, y, tail.a, tail.b, tail.c))
    if (isBubble) {
      color = dots.some((d) => inCircle(x, y, d.cx, d.cy, dotR)) ? PRIMARY : WHITE
    } else if (inRoundedRect(x, y, bg.x0, bg.y0, bg.x1, bg.y1, bg.r)) {
      color = PRIMARY
    }
    if (color) {
      raw[p] = color[0]; raw[p + 1] = color[1]; raw[p + 2] = color[2]; raw[p + 3] = 255
    } else {
      raw[p] = 0; raw[p + 1] = 0; raw[p + 2] = 0; raw[p + 3] = 0
    }
  }
}

// ---- 组装 PNG ----
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8  // bit depth
ihdr[9] = 6  // color type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
])

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'build'), { recursive: true })
const out = join(root, 'build', 'icon.png')
writeFileSync(out, png)
console.log(`[icon] 已生成 ${out} (${png.length} 字节)`)
