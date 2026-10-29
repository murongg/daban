export function redact(value: string, secrets: readonly string[]) {
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, '[credential redacted]');
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
}
export function redactStream(value: string, secrets: readonly string[]) {
  const text = redact(value, secrets);
  let end = text.length;
  // A key split across successive snapshots must not leak a growing prefix before full-key redaction can match it.
  for (const secret of secrets.filter(Boolean))
    for (let size = Math.min(secret.length - 1, text.length); size > 0; size--) {
      if (text.endsWith(secret.slice(0, size))) {
        end = Math.min(end, text.length - size);
        break;
      }
    }
  return text.slice(0, end);
}
