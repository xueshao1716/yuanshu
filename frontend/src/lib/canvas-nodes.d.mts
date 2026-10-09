import type { CanvasNode, CanvasEdge, CanvasView } from '../types'

export declare const CANVAS_LIMITS: {
  render: number
  zoom: { min: number; max: number }
  node: { max: number }
}
export declare const NODE_KINDS: Record<'prompt' | 'config' | 'image', {
  label: string
  w: number
  h: number
  outputs: string[]
  inputs: string[]
}>
export declare const NODE_STATUS: string[]
export declare const PANORAMA: {
  imageSize: string
  nodeSize: { width: number; height: number }
  geometry: string
  negative: string
  purity: string
  usage: string
}
export declare function nodeSizeFor(kind: string, template?: string): { w: number; h: number }
export declare function createNode(kind: string, patch?: Partial<CanvasNode>): CanvasNode
export declare function buildPanoramaPrompt(userPrompt: string, hasReference?: boolean): string
export declare function buildPrompt(opts?: {
  userPrompt?: string
  template?: string
  hasReference?: boolean
  negative?: string
}): string
export declare function canConnect(from: CanvasNode | undefined, to: CanvasNode | undefined): { ok: boolean; reason: string }
export declare function addEdge(edges: CanvasEdge[], from: CanvasNode, to: CanvasNode): { ok: boolean; reason: string; edges: CanvasEdge[]; edge?: CanvasEdge }
export declare function removeEdge(edges: CanvasEdge[], id: string): CanvasEdge[]
export declare function incoming(nodeId: string, edges: CanvasEdge[]): CanvasEdge[]
export declare function resolvePrompt(node: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[]): { text: string; sourceId: string | null; inherited: boolean }
export declare function resolveConfig(node: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[]): { provider: string; modelId: string; model: string; size: string; template: string; sourceId: string | null }
export declare function imageReady(node: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[]): { ok: boolean; reason: string }
export declare function imageRequest(node: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[]): { provider: string; modelId: string; prompt: string; size?: string }
export declare function finalPrompt(node: CanvasNode, nodes: CanvasNode[], edges: CanvasEdge[]): string
export declare class RenderGuard {
  constructor(limit?: number)
  limit: number
  order: string[]
  has(id: string): boolean
  touch(id: string): string[]
  evict(): string[]
  readonly ids: string[]
  readonly size: number
}
export declare function selectRenderable(candidates: string[], guard: RenderGuard): { render: string[]; degraded: string[] }
export declare function clampZoom(z: number): number
export declare function screenToWorld(pt: { x: number; y: number }, view: Partial<CanvasView>): { x: number; y: number }
export declare function worldToScreen(pt: { x: number; y: number }, view: Partial<CanvasView>): { x: number; y: number }
export declare function zoomAt(pointer: { x: number; y: number }, view: Partial<CanvasView>, factor: number): CanvasView
export declare function nextPosition(nodes: CanvasNode[], kind: string, size?: { w: number; h: number }): { x: number; y: number }
export declare function serializeCanvas(doc: { nodes: CanvasNode[]; edges: CanvasEdge[]; view: CanvasView }): string
export declare function parseCanvas(text: string): { ok: boolean; doc: { nodes: CanvasNode[]; edges: CanvasEdge[]; view: CanvasView } | null; errors: string[] }
