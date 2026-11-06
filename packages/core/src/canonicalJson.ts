/** JSON text with object keys in a stable order, for hashing a value. This is
 * never for a query parameter: those go through json() from db.ts. */
export const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
