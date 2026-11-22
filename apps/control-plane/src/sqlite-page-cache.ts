// SQLite grows the cache on demand. A negative value sets the target in KiB rather than pages.
export const FILE_BACKED_PAGE_CACHE_PRAGMA = "PRAGMA main.cache_size = -32768;";
