/**
 * 客户端消息本地存储（IndexedDB）
 * 解决刷新/切标签页导致流式内容丢失的问题
 */

import { reconcileTurnSnapshots } from './reconcile-turns.ts'
import { reconcileImageMessages } from './image-identity.ts'
import { cleanLegacyReferenceCache } from './legacy-media-cache.ts'

const DB_NAME = 'pi_web_messages'
const DB_VERSION = 1
const STORE_NAME = 'messages'

export interface LocalMessage {
  id: string                    // 前端生成的唯一ID（如 'u1735632000123' 或 'a1735632001456'）
  sessionId: string             // 会话ID
  role: 'user' | 'assistant' | 'system'
  text: string
  think?: string
  tools?: any[]
  notes?: string[]
  files?: any[]
  images?: string[]
  audios?: string[]
  videos?: string[]
  model?: { provider: string; id: string }
  requestedModel?: { provider: string; id: string }
  // 本轮失败原因（2026-09-16）：pi 通道失败只落一条 stopReason=error 的记录，
  // 本地库也存一份，刷新后错误条同样能显示出来。
  error?: string
  stopReason?: string | null
  // 输出被上限截断的人话说明（2026-09-18）：服务端每轮算好带过来，本地库留一份，
  // 刷新后琥珀色"被截断"提示条照样在。
  truncated?: string
  // 本轮主驾引擎 + 原因（②2026-09-16）
  engine?: string
  engineReason?: string
  // 本轮回答被重写/换模型过（刷新后也要看得见）
  switchedModel?: { provider: string; id: string; sameModel: boolean; reason: string }
  ts: string                    // ISO 时间戳
  synced: boolean               // 是否已同步到服务端（message_end 后标记 true）
  draft: boolean                // 是否是未完成的草稿（流式中标记 true，完成后改 false）
  streaming?: boolean           // 是否正在流式生成
}

let dbInstance: IDBDatabase | null = null

async function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return dbInstance

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      dbInstance = request.result
      resolve(dbInstance)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('sessionId', 'sessionId', { unique: false })
        store.createIndex('ts', 'ts', { unique: false })
      }
    }
  })
}

/**
 * 保存或更新一条消息
 */
export async function saveMessage(msg: LocalMessage): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.put(reconcileImageMessages([msg])[0])
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

/**
 * 批量保存消息
 */
export async function saveMessages(msgs: LocalMessage[]): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    
    reconcileImageMessages(msgs).forEach(msg => store.put(msg))
    
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * 获取指定会话的所有消息（按时间排序）
 */
export async function getMessages(sessionId: string): Promise<LocalMessage[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('sessionId')
    const request = index.getAll(sessionId)

    request.onsuccess = () => {
      const msgs = request.result || []
      // 按时间排序
      msgs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
      // Some old engine sessions persist only final text, without tool details.
      // Their completed local tool record can still prove a reference-only card.
      resolve(reconcileImageMessages(msgs.map(msg => cleanLegacyReferenceCache(msg))))
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * 获取单条消息
 */
export async function getMessage(id: string): Promise<LocalMessage | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const request = store.get(id)

    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

/**
 * 删除一条消息
 */
export async function deleteMessage(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.delete(id)

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

/**
 * 删除指定会话的所有消息
 */
export async function deleteSessionMessages(sessionId: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const index = store.index('sessionId')
    const request = index.openCursor(sessionId)

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      } else {
        resolve()
      }
    }
    request.onerror = () => reject(request.error)
  })
}

/**
 * 清空所有消息（慎用）
 */
export async function clearAllMessages(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.clear()

    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function mergeTools(localTools: any[] = [], serverTools: any[] = []): any[] {
  const merged = localTools.map(tool => ({ ...tool }))
  const indexById = new Map<string, number>()
  merged.forEach((tool, index) => {
    if (tool?.id) indexById.set(tool.id, index)
  })

  for (const serverTool of serverTools) {
    const toolId = serverTool?.id
    if (!toolId || !indexById.has(toolId)) {
      if (toolId) indexById.set(toolId, merged.length)
      merged.push({ ...serverTool })
      continue
    }

    const index = indexById.get(toolId)!
    const localTool = merged[index]
    const finalResult = Object.prototype.hasOwnProperty.call(serverTool, 'output')
      || Object.prototype.hasOwnProperty.call(serverTool, 'isError')
    merged[index] = {
      ...localTool,
      ...serverTool,
      ...(finalResult ? {
        running: false,
        status: serverTool.isError ? 'error' : 'completed',
      } : {}),
    }
  }
  return merged
}

function mergeServerMessage(local: LocalMessage, server: any): LocalMessage {
  local = cleanLegacyReferenceCache(local, server)
  // text 覆盖规则（2026-09-20）：仅当服务端文本是本地文本的延长（本地为空，或服务端以本地为前缀且更长，
  // 即流式半截场景）才取服务端全文；其余情况维持本地优先（同 id 等长文本等既有语义不变）。
  const localText = local.text || ''
  const serverText = server.text || ''
  const text = !localText || (serverText.length > localText.length && serverText.startsWith(localText))
    ? (serverText || localText)
    : localText
  return {
    ...local,
    text,
    think: local.think || server.think,
    tools: mergeTools(local.tools, server.tools),
    notes: local.notes?.length ? local.notes : server.notes,
    files: local.files?.length ? local.files : server.files,
    images: local.images?.length ? local.images : (server.images ?? local.images),
    audios: local.audios?.length ? local.audios : (server.audios ?? local.audios),
    videos: local.videos?.length ? local.videos : (server.videos ?? local.videos),
    model: server.model || local.model,
    requestedModel: server.requestedModel || local.requestedModel,
    switchedModel: server.switchedModel || local.switchedModel,
    engine: server.engine || local.engine,
    truncated: local.truncated || server.truncated,
    // 本地消息的 draft/streaming/synced 状态描述本地生命周期，不能被服务端副本抹掉。
    draft: local.draft,
    streaming: local.streaming,
    synced: local.synced,
  }
}

/**
 * 合并服务端消息与本地消息：先按消息 id/文本指纹，再按 toolCallId 归并工具消息。
 * 工具只按 id 识别；相同 name/args 但 id 不同的调用必须分别保留。
 */
export function mergeMessages(localMsgs: LocalMessage[], serverMsgs: any[]): LocalMessage[] {
  const merged: LocalMessage[] = localMsgs.map(message => ({
    ...message,
    tools: message.tools?.map(tool => ({ ...tool })),
  }))
  const contentKeyOf = (role: string, text: string) => `${role}|${(text || '').trim().slice(0, 300)}`
  const byId = new Map<string, number>()
  const byContent = new Map<string, number[]>()
  const byTool = new Map<string, number>()

  const indexAt = (i: number, message: LocalMessage) => {
    byId.set(message.id, i)
    if (message.text?.trim()) {
      const key = contentKeyOf(message.role, message.text)
      const arr = byContent.get(key) || []
      arr.push(i)
      byContent.set(key, arr)
    }
    for (const tool of message.tools || []) {
      if (tool?.id) byTool.set(tool.id, i)
    }
  }
  merged.forEach((message, i) => indexAt(i, message))

  const findMessageIndex = (server: any, serverId: string): number => {
    if (byId.has(serverId)) return byId.get(serverId) as number
    const serverTs = new Date(server.ts).getTime()
    if (server.text?.trim()) {
      const key = contentKeyOf(server.role, server.text)
      for (const i of byContent.get(key) || []) {
        const message = merged[i]
        if (Math.abs(new Date(message.ts).getTime() - serverTs) < 120_000) return i
      }
      // 流式半截副本兜底（2026-09-20）：本地 IndexedDB 存的是断流时刻的 3s 快照（半截文本），
      // 服务端是全文——id 不同（前端生成 vs 引擎 id）、前 300 字指纹对不上（半截不足 300 字）、
      // ts 差超 2 分钟（带工具的长回合），三层全失配 → 同一段话出现两条（半截 + 全文）。
      // 用前缀关系归并：同 role、一方是另一方前缀、较长方 ≥80 字（避免"你是谁"×2 这类真实短消息重复被误并）、ts 差 < 30 分钟。
      const serverText = server.text.trim()
      if (serverText.length >= 80) {
        for (let i = 0; i < merged.length; i++) {
          const m = merged[i]
          const localText = m.text?.trim() || ''
          if (m.role !== server.role || localText.length < 40) continue
          if (Math.abs(new Date(m.ts).getTime() - serverTs) >= 1_800_000) continue
          if (serverText.startsWith(localText) || localText.startsWith(serverText)) return i
        }
      }
    }
    for (const tool of server.tools || []) {
      if (tool?.id && byTool.has(tool.id)) return byTool.get(tool.id) as number
    }
    return -1
  }

  for (const server of reconcileTurnSnapshots(localMsgs, serverMsgs)) {
    const serverId = server.id || `${server.role}_${new Date(server.ts).getTime()}`
    const matchIndex = findMessageIndex(server, serverId)
    if (matchIndex >= 0) {
      merged[matchIndex] = mergeServerMessage(merged[matchIndex], server)
      // 服务端知道"这一轮失败了"而本地旧副本不知道（2026-09-16）：
      // 本地优先策略会把 error 字段盖掉，于是失败条永远不显示——缺就补上。
      if (server.error && !merged[matchIndex].error) {
        merged[matchIndex].error = server.error
        merged[matchIndex].stopReason = server.stopReason || 'error'
      }
      indexAt(matchIndex, merged[matchIndex])
      continue
    }

    merged.push({
      id: serverId,
      sessionId: server.sessionId || '',
      role: server.role,
      text: server.text || '',
      think: server.think,
      tools: mergeTools([], server.tools),
      notes: server.notes,
      files: server.files,
      images: server.images,
      audios: server.audios,
      videos: server.videos,
      model: server.model,
      requestedModel: server.requestedModel,
      switchedModel: server.switchedModel,
      engine: server.engine,
      error: server.error,
      stopReason: server.stopReason,
      ts: server.ts,
      synced: true,
      draft: false,
    })
    indexAt(merged.length - 1, merged[merged.length - 1])
  }

  merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
  return reconcileImageMessages(merged)
}
