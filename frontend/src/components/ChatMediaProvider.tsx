import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import ImageViewer from './ImageViewer'
import { collectChatMedia, mediaFilename, type ChatMedia } from '../lib/chat-media'
import { mediaPathKey } from '../lib/media-embed'
import type { ChatMessage } from '../types'

const GalleryContext = createContext<((src: string, kind: ChatMedia['kind']) => void) | null>(null)
export const useChatMedia = () => useContext(GalleryContext)

/** Keyed by session: switching chats discards the open gallery. */
export default function ChatMediaProvider({ sessionId, messages, children }: { sessionId: string; messages: Partial<ChatMessage>[]; children: ReactNode }) {
  const [gallery, setGallery] = useState<{ items: ChatMedia[]; index: number } | null>(null)
  const close = useCallback(() => setGallery(null), [])
  const open = (src: string, kind: ChatMedia['kind']) => {
    const items = collectChatMedia(messages, sessionId)
    let index = items.findIndex(item => item.kind === kind && mediaPathKey(item.src) === mediaPathKey(src))
    if (index < 0) { index = items.length; items.push({ src, kind, name: mediaFilename(src, kind) }) }
    setGallery({ items, index })
  }
  return <GalleryContext.Provider value={open}>
    {children}
    {gallery && <ImageViewer src={gallery.items[gallery.index].src} items={gallery.items} initialIndex={gallery.index} onClose={close} />}
  </GalleryContext.Provider>
}
