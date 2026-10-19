/**
 * Prototype-safe table lookup (E01/E02 prototype-key sweep). A plain `table[key]` with a wire or
 * untrusted string returns inherited members for keys such as `constructor`, `__proto__`,
 * `toString`, `hasOwnProperty`, `valueOf`, `isPrototypeOf` or `__defineGetter__`. This returns the
 * table's OWN value or undefined, so callers fall back instead of leaking a function into copy.
 */
export function own<K extends string, V>(table: Readonly<Partial<Record<K, V>>>, key: string): V | undefined {
  return Object.hasOwn(table, key) ? (table as Readonly<Record<string, V>>)[key] : undefined;
}
