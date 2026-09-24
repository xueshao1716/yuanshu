/** Copy text with a browser API first and a textarea fallback for WebView/Tauri shells. */
export async function copyText(value: string): Promise<boolean> {
  if (!value) return false
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {}

  if (typeof document === 'undefined') return false
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
  const start = active?.selectionStart, end = active?.selectionEnd, direction = active?.selectionDirection
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  let copied = false
  try {
    document.body.appendChild(textarea)
    textarea.select()
    copied = document.execCommand('copy')
  } catch {} finally {
    textarea.remove()
    try {
      active?.focus({ preventScroll: true })
      if (typeof start === 'number' && typeof end === 'number') active?.setSelectionRange(start, end, direction || undefined)
      else if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)) }
    } catch {}
  }
  return copied
}
