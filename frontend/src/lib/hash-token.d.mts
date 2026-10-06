export function readHashToken(loc: { hostname?: string; hash?: string } | null | undefined): string
export function consumeHashToken(opts: {
  location?: { hostname?: string; hash?: string; pathname?: string; search?: string }
  history?: { replaceState(data: unknown, unused: string, url?: string): void }
  storage?: { setItem(k: string, v: string): void; removeItem(k: string): void }
  tokenKey: string
  apiBaseKey: string
}): string
