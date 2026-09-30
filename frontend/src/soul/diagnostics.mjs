/** Skill inventories may contain old strings or structured loader diagnostics. */
export function diagnosticMessages(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === 'string' ? item : item?.message)
    .filter(message => typeof message === 'string' && message.trim());
}
