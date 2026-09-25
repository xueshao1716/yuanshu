type WritableFile = { write(blob: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
export type BrowserSaveHandle = { createWritable(): Promise<WritableFile> }
type SaveHost = { YuanshuDownloads?: unknown; YuanshuBridge?: unknown; showSaveFilePicker?: (options: { suggestedName: string }) => Promise<BrowserSaveHandle> }

/** Call before the first await: browsers require the original button activation. */
export async function requestBrowserSave(filename: string, host: SaveHost = globalThis as SaveHost): Promise<BrowserSaveHandle | null> {
  if (host.YuanshuDownloads || host.YuanshuBridge || !host.showSaveFilePicker) return null
  try { return await host.showSaveFilePicker({ suggestedName: filename }) }
  catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('已取消保存')
    if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') return null
    throw error
  }
}

export async function writeBrowserSave(handle: BrowserSaveHandle, blob: Blob): Promise<void> {
  const writer = await handle.createWritable()
  try { await writer.write(blob); await writer.close() }
  catch (error) { try { await writer.abort() } catch { /* Preserve the write failure. */ } throw error }
}
