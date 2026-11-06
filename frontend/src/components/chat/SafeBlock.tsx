import { Component, type ReactNode } from 'react'

// 迷你错误边界（nomifun SyntaxHighlightBoundary 模式，2026-08-25）：
// 包住单个自定义渲染块（mermaid/dsh-ui/高亮代码），抛错只降级该块，
// 不炸整条消息；resetKey 变化自动复位重试。
interface SafeBlockProps {
  /** 内容指纹：变化时自动复位（如代码内容更新后重试渲染） */
  resetKey?: string
  /** 失败时的降级渲染（默认纯文本 pre） */
  fallback?: ReactNode
  children: ReactNode
}

export default class SafeBlock extends Component<SafeBlockProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidUpdate(prev: SafeBlockProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render() {
    if (this.state.failed) {
      return this.props.fallback ?? null
    }
    return this.props.children
  }
}
