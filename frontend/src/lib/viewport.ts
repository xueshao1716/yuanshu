function visibleViewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight
}

function layoutViewportHeight(): number {
  return Math.max(window.innerHeight, document.documentElement.clientHeight)
}

/** WindowInsets 是物理像素。矮屏（荣耀畅玩 HD+）若把 800px 当 CSS 高度，输入框会被顶到最上。 */
export function nativeImeToCss(raw: number, layoutHeight: number, dpr: number): number {
  const height = Math.max(1, layoutHeight)
  const density = Math.max(1, dpr)
  let n = Math.max(0, Number(raw) || 0)
  if (n > height) n = n / density
  return Math.min(n, height * 0.45)
}

let nativeKeyboardInset = 0

function isTextEditorFocused(): boolean {
  const element = document.activeElement
  return element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement
    || element?.getAttribute('contenteditable') === 'true'
}

/**
 * Keep a pre-IME height so an Android WebView that only reports WindowInsets
 * can be shortened without requiring the layout viewport itself to resize.
 */
function installViewportController() {
  let baseLayoutHeight = layoutViewportHeight()
  let update = () => {}

  const visualInset = () => {
    const viewport = window.visualViewport
    if (!viewport) return 0
    return Math.max(0, layoutViewportHeight() - (viewport.height + viewport.offsetTop))
  }

  const updateBaseHeight = () => {
    const layoutHeight = layoutViewportHeight()
    const visualKeyboardInset = visualInset()
    // 只在键盘关闭时更新基准，避免 adjustResize 的临时小高度污染基准。
    if (nativeKeyboardInset <= 80 && visualKeyboardInset <= 80) baseLayoutHeight = layoutHeight
    else if (layoutHeight > baseLayoutHeight) baseLayoutHeight = layoutHeight
  }

  const effectiveHeight = () => {
    const layoutHeight = layoutViewportHeight()
    const visualHeight = visibleViewportHeight()
    const visualKeyboardInset = visualInset()

    if (nativeKeyboardInset > 80) {
      // visualViewport 已经避让时，直接使用它，不能再扣一次原生 inset。
      if (visualKeyboardInset > 80) return visualHeight
      // adjustResize 已经缩短布局时，使用缩短后的布局高度。
      if (layoutHeight < baseLayoutHeight - 80) return layoutHeight
      // overlay IME：布局没变，只能用原生 inset 计算可见高度；至少留一半以上，避免输入框被抬到屏幕上沿。
      return Math.max(layoutHeight * 0.55, baseLayoutHeight - nativeKeyboardInset)
    }
    return visualHeight
  }

  const keyboardState = () => {
    const visualKeyboardInset = visualInset()
    const inset = Math.max(nativeKeyboardInset, visualKeyboardInset)
    const open = inset > 80
    const overlay = nativeKeyboardInset > 80 && visualKeyboardInset <= 80
      && layoutViewportHeight() >= baseLayoutHeight - 80
    return { inset, open, overlay }
  }

  update = () => {
    updateBaseHeight()
    const height = effectiveHeight()
    const state = keyboardState()
    document.documentElement.style.setProperty('--pi-viewport-height', `${height}px`)
    document.documentElement.style.setProperty('--pi-keyboard-inset', `${state.inset}px`)
    document.documentElement.style.setProperty('--pi-native-keyboard-inset', `${nativeKeyboardInset}px`)
    const keyboardOpen = state.open && isTextEditorFocused()
    document.documentElement.classList.toggle('keyboard-open', keyboardOpen)
    document.documentElement.classList.toggle('keyboard-overlay', keyboardOpen && state.overlay)
    document.documentElement.classList.toggle('keyboard-native', keyboardOpen && nativeKeyboardInset > 80)
  }

  const onNativeIme = (event: Event) => {
    const detail = (event as CustomEvent<{ height?: number }>).detail
    nativeKeyboardInset = nativeImeToCss(
      Number(detail?.height) || 0,
      layoutViewportHeight(),
      window.devicePixelRatio || 1,
    )
    update()
  }

  const viewport = window.visualViewport
  update()
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  window.addEventListener('orientationchange', update)
  window.addEventListener('yuanshu-ime', onNativeIme)
  document.addEventListener('focusin', update)
  document.addEventListener('focusout', update)

  return () => {
    viewport?.removeEventListener('resize', update)
    viewport?.removeEventListener('scroll', update)
    window.removeEventListener('resize', update)
    window.removeEventListener('orientationchange', update)
    window.removeEventListener('yuanshu-ime', onNativeIme)
    document.removeEventListener('focusin', update)
    document.removeEventListener('focusout', update)
    document.documentElement.classList.remove('keyboard-open', 'keyboard-overlay', 'keyboard-native')
    document.documentElement.style.removeProperty('--pi-viewport-height')
    document.documentElement.style.removeProperty('--pi-keyboard-inset')
    document.documentElement.style.removeProperty('--pi-native-keyboard-inset')
  }
}

/** Keep the mobile app and composer aligned with the actually visible viewport. */
export function installVisualViewportHeight(): () => void {
  return installViewportController()
}
