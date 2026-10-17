const TTL_MS = 30_000;
const MAX_ENTRIES = 500;

interface Entry {
  productIds: number[];
  expiresAt: number;
}

// Caches which products match a search, never the rows themselves, so stock written by any component is never stale.
// SIMPLIFIED: per-process and size-capped; a second API instance misses new products until TTL. Move to Redis if scaled out.
const productSearchCache = new Map<string, Entry>();

export function cacheKey(query: string): string {
  return query.trim().toLowerCase();
}

export function getCachedSearch(query: string, now = Date.now()): number[] | undefined {
  const entry = productSearchCache.get(cacheKey(query));
  return entry !== undefined && entry.expiresAt > now ? entry.productIds : undefined;
}

export function setCachedSearch(query: string, productIds: number[], now = Date.now()): void {
  const key = cacheKey(query);
  // Map iterates in insertion order, so the first key is the oldest.
  if (!productSearchCache.has(key) && productSearchCache.size >= MAX_ENTRIES) {
    const oldest = productSearchCache.keys().next();
    if (oldest.done !== true) productSearchCache.delete(oldest.value);
  }
  productSearchCache.set(key, { productIds, expiresAt: now + TTL_MS });
}

/** Call after anything that changes which products match a search (new or renamed products). */
export function invalidateSearchCache(): void {
  productSearchCache.clear();
}

export function evictExpired(now = Date.now()): void {
  for (const [key, entry] of productSearchCache) if (entry.expiresAt <= now) productSearchCache.delete(key);
}

// unref so the timer never keeps the process (or a test run) alive on its own.
setInterval(evictExpired, TTL_MS).unref();
