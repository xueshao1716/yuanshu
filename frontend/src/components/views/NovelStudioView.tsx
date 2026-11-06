import { useState } from 'react'
import NovelShelf from '../novel/NovelShelf'
import NovelWorkbench from '../novel/NovelWorkbench'

export default function NovelStudioView() {
  const [openId, setOpenId] = useState<string | null>(null)
  return openId ? <NovelWorkbench id={openId} onBack={() => setOpenId(null)} /> : <NovelShelf onOpen={setOpenId} />
}
