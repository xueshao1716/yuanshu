import {api, downloadApiFile} from '../api'
export type WebsiteDoc = {html: string; css: string}
export type WebsiteVersion = {id: string; label: string; createdAt: string; doc: WebsiteDoc; model?: {provider: string; id: string}}
export type WebsiteRun = {id: string; status: string; stage: string; startedAt: string; error?: string; requestedModel: string; actualModel?: string; lastSuccessfulModel?: string; progress?: {phase: string; characters: number; thinkingCharacters: number; at?: string}; resultVersion?: string; checkpoint?: {plan?: {sections: {title: string}[]}; sections: WebsiteDoc[]; partial?: {text: string}}; events: {stage: string; message: string; at: string}[]}
export type WebsiteProject = {id: string; title: string; brief: string; selectedVersion: string; versions: WebsiteVersion[]; run?: WebsiteRun}
export type WebsiteSummary = Pick<WebsiteProject,'id'|'title'|'brief'> & {versionCount: number; updatedAt: string}
export type WebsiteTemplate = {id: string; name: string; subtitle: string; preview: string; tone: string}
const base='/api/workshop-sites/projects'
export const websites = {
  templates: () => api<{templates: WebsiteTemplate[]}>('/api/workshop-sites/templates'),
  list: () => api<{projects: WebsiteSummary[]}>(base),
  get: (id: string) => api<WebsiteProject>(`${base}/${id}`),
  create: (body: object) => api<WebsiteProject>(base,{method:'POST',body}),
  save: (id: string, doc: WebsiteDoc, parentId: string) => api<WebsiteVersion>(`${base}/${id}/versions`,{method:'POST',body:{doc,parentId}}),
  select: (id: string, versionId: string) => api<WebsiteProject>(`${base}/${id}/select`,{method:'POST',body:{versionId}}),
  generate: (id: string, body: object) => api<WebsiteRun>(`${base}/${id}/generate`,{method:'POST',body}),
  cancel: (id: string) => api<WebsiteProject>(`${base}/${id}/cancel`,{method:'POST',body:{}}),
  share: (id: string, versionId: string) => api<{url: string; message: string}>(`${base}/${id}/share`,{method:'POST',body:{versionId}}),
  download: (id: string, versionId: string) => downloadApiFile(`${base}/${id}/export/${versionId}`),
}
export function previewDocument(doc: WebsiteDoc) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; font-src https:; base-uri 'none'; form-action 'none'"><style>${doc.css.replace(/<\/style/gi,'')}</style></head><body>${doc.html}</body></html>`
}
