/**
 * A 16×16 PNG a browser can decode. An image the browser can't show (the bare PNG signature some
 * specs used) now raises the composer's broken-image notice (#2177), so specs that only need an
 * attached image use this one.
 */
export const DECODABLE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAB3klEQVR42g3LIc6GIACA4f843wE8gAfwAIzoSCZmdCQTIzISiRmZyeSMjPDOxMwe5vfpz99P0kl6ySAREiXREiOxkiBJkl1ySqqkSV7J32+kG+lHhhExokb0iBmxI2Ekjewj50gdaSPv+IWJbqKfGCbEhJrQE2bCToSJNLFPnBN1ok280xdmupl+ZpgRM2pGz5gZOxNm0sw+c87UmTbzzl9Y6Bb6hWFBLKgFvWAW7EJYSAv7wrlQF9rCu3xhpVvpV4YVsaJW9IpZsSthJa3sK+dKXWkr7/oFR+foHYNDOJRDO4zDOoIjOXbH6aiO5njdFzydp/cMHuFRHu0xHusJnuTZPaeneprn9V+IdJE+MkREREV0xERsJERSZI+ckRppkTd+YaPb6DeGDbGhNvSG2bAbYSNt7BvnRt1oG+/2hUyX6TNDRmRURmdMxmZCJmX2zJmpmZZ58xcOuoP+YDgQB+pAH5gDexAO0sF+cB7Ug3bwHl+46C76i+FCXKgLfWEu7EW4SBf7xXlRL9rFe32h0BX6wlAQBVXQBVOwhVBIhb1wFmqhFd7yhZvupr8ZbsSNutE35sbehJt0s9+cN/Wm3bz3Fx66h/5heBAP6kE/mAf7EB7Sw/5wPtSH9vA+/ANfBeAQPyK7DgAAAABJRU5ErkJggg==";

export const DECODABLE_PNG = Buffer.from(DECODABLE_PNG_BASE64, "base64");

/** The bare PNG signature: passes the MIME-and-size gate, but no browser can draw it. */
export const UNDRAWABLE_PNG = Buffer.from([137, 80, 78, 71]);
