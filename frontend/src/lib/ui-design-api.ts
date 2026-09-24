import { api, apiUrl } from '../api'
export type DesignDoc = { title?: string; groups: { id: string; items: {label: string}[] }[]; frames: unknown[] }
export type DesignVersion = { id: string; label: string; createdAt: string; doc: DesignDoc; model: {provider: string; id: string} | null }
export type DesignProject = { id: string; title: string; brief: string; references: string; selectedVersion: string | null; versions: DesignVersion[]; run: {status: string; completed: number; total: number; error?: string} | null }
export type DesignSummary = Pick<DesignProject, 'id' | 'title' | 'brief'> & {versionCount: number}
const base = '/api/workshop-ui/projects'
export const designs = {
  list: () => api<{projects: DesignSummary[]}>(base),
  get: (id: string) => api<DesignProject>(`${base}/${id}`),
  create: (body: {title: string; brief: string; references: string}) => api<DesignProject>(base, {method:'POST', body}),
  select: (id: string, versionId: string) => api<DesignProject>(`${base}/${id}/select`, {method:'POST', body:{versionId}}),
  generate: (id: string, body: object) => api(`${base}/${id}/generate`, {method:'POST', body}),
}
export function openDesign(project: DesignProject, version: DesignVersion) {
  const url = new URL(apiUrl('/static/workshop-ui/index.html'), location.href)
  if (url.origin !== location.origin) throw new Error('画布需在服务端网页登录后打开。请用浏览器访问当前服务地址；作品和版本已保存。')
  const key = `m3e:doc:${project.id}:${version.id}`
  // Resume an existing draft, never overwrite it merely by opening a version.
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(version.doc))
  sessionStorage.setItem('yuanshu-ui-project', project.id)
  url.search = new URLSearchParams({vanilla:'1', project:project.id, version:version.id}).toString()
  location.assign(url.href)
}
