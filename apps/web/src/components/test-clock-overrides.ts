/** Keep clock stubs local to one test, including when its assertions throw. */
export async function withScopedClockOverrides<T>(
  target: object,
  overrides: Partial<Record<"setTimeout" | "clearTimeout" | "setInterval" | "clearInterval" |
    "requestAnimationFrame" | "cancelAnimationFrame", unknown>>,
  body: () => Promise<T> | T,
): Promise<T> {
  const descriptors: Array<{ key: string; descriptor: PropertyDescriptor | undefined }> = [];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      Object.defineProperty(target, key, { configurable: true, writable: true, value });
      descriptors.push({ key, descriptor });
    }
    return await body();
  } finally {
    for (const { key, descriptor } of descriptors.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  }
}

export async function withCapturedAnimationFrames<T>(
  target: object,
  body: (frames: { pending: () => number; flush: () => void }) => Promise<T> | T,
): Promise<T> {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return withScopedClockOverrides(target, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id: number) => { callbacks.delete(id); },
  }, () => body({
    pending: () => callbacks.size,
    flush: () => {
      const ready = [...callbacks.values()];
      callbacks.clear();
      for (const callback of ready) callback(0);
    },
  }));
}
