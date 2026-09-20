// 渲染层的 window.api 类型声明（实现见 src/preload/index.ts，接口定义见 src/shared/types.ts）
import type { Api } from '@shared/types'

declare global {
  interface Window {
    api: Api
  }
}

export {}
