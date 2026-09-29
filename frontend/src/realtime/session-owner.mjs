// Keep an initiating composer alive only when it adopts its own initial session.
// Every unrelated selection still tears down calls, drafts and gallery state.
export function createSessionViewOwner() {
  let selected = null, adopted = null, key = 0
  return {
    adopt(id) { if (!selected) adopted = id },
    keyFor(id) {
      const next = id || null
      if (next !== selected) {
        if (selected || !next || next !== adopted) key++
        selected = next; adopted = null
      }
      return key
    },
  }
}
