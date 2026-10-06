const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The name to show for an operator identifier recorded on a sign-off. The
 * server resolves identifiers to display names; when one cannot be resolved,
 * an email is still readable, but a raw id never is, so it is not shown.
 */
export function operatorName(names: Record<string, string>, identifier: string | null): string {
  if (!identifier) return '—';
  return names[identifier] ?? (UUID_SHAPE.test(identifier) ? 'another operator' : identifier);
}

/** Whether a recorded identifier is the signed-in viewer (email, or id on older rows). */
export function isViewer(
  identifier: string | null,
  viewer: { id: string; email: string },
): boolean {
  return identifier !== null && (identifier === viewer.email || identifier === viewer.id);
}
