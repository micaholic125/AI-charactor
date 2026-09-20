// 供应商配置（API 配置栏目）：providers.json 的读写、旧数据迁移、地址去重
// 规范见 docs/tech.md §3、需求见 docs/requirements.md §3.7
//
// 核心约定：Provider.id === normalizeProviderUrl(baseUrl)，**接口地址就是身份**，天然去重；
// 改地址 = 换了一条新的供应商。`name` 只是给人看的名字（界面显示用），不参与去重。

import { promises as fs } from 'fs'
import type { Provider, Settings } from '@shared/types'
import {
  DEFAULT_PROVIDER_BASE_URL,
  DEFAULT_PROVIDER_MODEL,
  normalizeProviderUrl
} from '@shared/types'
import { enqueueWrite, getSettings, providersFilePath, readRawSettings, saveSettings } from './store'

let providers: Provider[] = []

/** 读取 providers.json；文件不存在或损坏都返回 null（由调用方决定迁移还是重建） */
async function readProvidersFile(): Promise<Provider[] | null> {
  const file = providersFilePath()
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Provider[]
    if (!Array.isArray(parsed)) throw new Error('格式不正确')
    return parsed
  } catch {
    // 文件存在但坏了：先备份，避免用户配置直接消失
    await fs.rename(file, `${file}.bak`).catch(() => {})
    return null
  }
}

/** 把任意来源的条目清洗成合法的 Provider（缺 id 时按地址补上，地址为空的条目直接丢弃） */
function normalizeProvider(input: Provider): Provider | null {
  const id = normalizeProviderUrl(input?.baseUrl ?? input?.id ?? '')
  if (id === '') return null
  const now = Date.now()
  return {
    id,
    baseUrl: (input.baseUrl ?? '').trim(),
    // 旧数据没有 name：归一为「没起名」，让界面照旧显示接口地址
    name: typeof input.name === 'string' ? input.name.trim() : '',
    apiKey: (input.apiKey ?? '').trim(),
    model: (input.model ?? '').trim() || DEFAULT_PROVIDER_MODEL,
    // 旧数据没有这两个字段：归一为「还没获取过」，让用户点一次「获取模型列表」
    models: normalizeModels(input?.models),
    modelsFetchedAt: Number(input?.modelsFetchedAt) || 0,
    // 旧数据没有常用模型：归一为「没挑过」，聊天页照旧列全部
    commonModels: normalizeModels(input?.commonModels),
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now
  }
}

/** 模型列表归一：只留非空字符串、去掉首尾空白（过滤与排序在 chatClient.tidyModels 里做） */
function normalizeModels(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input.map((m) => (typeof m === 'string' ? m.trim() : '')).filter((m) => m !== '')
}

function persistProviders(): Promise<void> {
  return enqueueWrite(providersFilePath(), JSON.stringify(providers, null, 2))
}

/** 保证「使用中」指向一条真实存在的供应商，返回是否有改动 */
async function fixCurrentProvider(): Promise<boolean> {
  const settings = getSettings()
  if (providers.length === 0) {
    if (settings.currentProviderId === '') return false
    await saveSettings({ ...settings, currentProviderId: '' })
    return true
  }
  if (providers.some((p) => p.id === settings.currentProviderId)) return false
  await saveSettings({ ...settings, currentProviderId: providers[0].id })
  return true
}

/**
 * 初始化供应商配置（app ready 后、注册 IPC 之前调用一次）。
 * 首次运行（providers.json 不存在）时做两件事之一：
 *   1. 旧版本升级：把 settings.json 里的 baseUrl/apiKey/model 迁成第一条供应商，用户不用重填
 *   2. 全新安装：预置一条 DeepSeek 供应商（Key 为空），用户只需粘贴 Key
 */
export async function ensureProviders(): Promise<void> {
  const loaded = await readProvidersFile()
  if (loaded) {
    providers = loaded.map(normalizeProvider).filter((p): p is Provider => p !== null)
    if (providers.length !== loaded.length) await persistProviders()
    await fixCurrentProvider()
    return
  }

  // 旧数据迁移：settings.json 里还留着接口地址才迁
  const raw = await readRawSettings()
  const legacyUrl = normalizeProviderUrl(typeof raw.baseUrl === 'string' ? raw.baseUrl : '')
  const seed: Provider = {
    id: legacyUrl || normalizeProviderUrl(DEFAULT_PROVIDER_BASE_URL),
    baseUrl: legacyUrl || DEFAULT_PROVIDER_BASE_URL,
    // 老用户迁移过来的地址五花八门，不替他们起名（留空即显示地址）；全新安装才给个「DeepSeek」
    name: legacyUrl ? '' : 'DeepSeek',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    model: (typeof raw.model === 'string' ? raw.model.trim() : '') || DEFAULT_PROVIDER_MODEL,
    models: [],
    modelsFetchedAt: 0,
    commonModels: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  providers = [seed]
  await persistProviders()

  const settings = getSettings()
  const next: Settings = { ...settings, currentProviderId: seed.id }
  await saveSettings(next)
}

// ---------- 读写 ----------

export function listProviders(): Provider[] {
  return [...providers].sort((a, b) => a.createdAt - b.createdAt)
}

export function getProvider(id: string): Provider | undefined {
  return providers.find((p) => p.id === id)
}

/** 当前使用的供应商；没有配置过时返回 undefined（发请求时报中文错误引导用户去配） */
export function getCurrentProvider(): Provider | undefined {
  return getProvider(getSettings().currentProviderId)
}

/**
 * 新建（id 为空）或更新一条供应商。**改地址 = 换了一条**：旧 id 的条目会被移除。
 * 地址撞上已有条目则合并覆盖（覆盖 Key 与模型），不会出现两条同地址的记录。
 * 保存后自动设为「使用中」——刚配好就是要用它。
 */
export async function saveProvider(input: Provider): Promise<Provider> {
  const next = normalizeProvider(input)
  if (!next) throw new Error('请填写接口地址')

  const oldId = normalizeProviderUrl(input.id ?? '')
  // createdAt 保留最早那条的时间（地址没变就是同一条记录的更新）
  const existing = getProvider(next.id) ?? getProvider(oldId)
  providers = providers.filter((p) => p.id !== oldId && p.id !== next.id)

  const merged: Provider = {
    ...next,
    createdAt: existing?.createdAt ?? next.createdAt,
    updatedAt: Date.now()
  }
  providers.push(merged)
  await persistProviders()

  await saveSettings({ ...getSettings(), currentProviderId: merged.id })
  return merged
}

/** 删除一条供应商；删掉正在使用的则把「使用中」落到剩余第一条 */
export async function deleteProvider(id: string): Promise<{ currentProviderId: string }> {
  const before = providers.length
  providers = providers.filter((p) => p.id !== id)
  if (providers.length === before) throw new Error('供应商不存在')
  await persistProviders()
  await fixCurrentProvider()
  return { currentProviderId: getSettings().currentProviderId }
}

/** 切换使用中的供应商 */
export async function setCurrentProvider(id: string): Promise<Settings> {
  if (!getProvider(id)) throw new Error('供应商不存在')
  return saveSettings({ ...getSettings(), currentProviderId: id })
}
