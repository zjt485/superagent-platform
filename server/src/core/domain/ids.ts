const SHORT_NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Generate a six-character ticket short name such as `t-a1b2c3`. */
export function ticketShortName(random: () => number = Math.random): string {
  let value = ''
  for (let index = 0; index < 6; index += 1) {
    const slot = Math.min(
      SHORT_NAME_ALPHABET.length - 1,
      Math.max(0, Math.floor(random() * SHORT_NAME_ALPHABET.length)),
    )
    value += SHORT_NAME_ALPHABET[slot]
  }
  return `t-${value}`
}

/** Branch name for a ticket, always under the policy's agent prefix. */
export function branchName(shortName: string, prefix = 'agent/'): string {
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`
  return `${normalized}${shortName}`
}
