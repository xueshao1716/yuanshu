import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

const hash = value => createHash('sha256').update(value || '').digest('hex')
const matches = (a, b) => typeof a === 'string' && typeof b === 'string' && !!b &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export function createVoiceAdmission({ getToken, readSession, now = Date.now, maxTickets = 32, maxIssues = 10 }) {
  const tickets = new Map(), active = new Set()
  let windowAt = now(), issues = 0
  function login() { return hash(getToken()) }
  return {
    issue(req, conversationId) {
      const token = getToken()
      if (!matches(req.headers.authorization, `Bearer ${token}`) || !token) throw new Error('unauthorized')
      const current = login(), time = now()
      if (active.has(current)) throw new Error('call_busy')
      if (time - windowAt >= 60000) { windowAt = time; issues = 0 }
      for (const [ticket, claim] of tickets) if (claim.expires <= time) tickets.delete(ticket)
      if (++issues > maxIssues || tickets.size >= maxTickets) throw new Error('rate_limit')
      if (!readSession(conversationId)) throw new Error('conversation_gone')
      const ticket = randomBytes(32).toString('base64url')
      tickets.set(hash(ticket), { login: current, conversationId, expires: time + 60000 })
      return { ticket, expiresIn: 60 }
    },
    consume(ticket) {
      if (typeof ticket !== 'string' || ticket.length !== 43) return null
      const key = hash(ticket), claim = tickets.get(key); tickets.delete(key)
      return claim && claim.expires > now() && claim.login === login() && readSession(claim.conversationId) ? claim : null
    },
    valid: claim => !!claim && claim.login === login() && !!readSession(claim.conversationId),
    acquire(claim) { if (!claim || active.has(claim.login)) return false; active.add(claim.login); return true },
    release(claim) { if (claim) active.delete(claim.login) },
  }
}
