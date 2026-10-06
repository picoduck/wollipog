export interface TranscriptDownloadDependencies {
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  createAnchor(): { href: string; download: string; hidden: boolean; click(): void; remove(): void };
  appendAnchor(anchor: HTMLElement): void;
  schedule(callback: () => void, delayMs: number): void;
}

const browserDependencies: TranscriptDownloadDependencies = {
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  createAnchor: () => document.createElement("a"),
  appendAnchor: (anchor) => document.body.append(anchor),
  schedule: (callback, delayMs) => { window.setTimeout(callback, delayMs); },
};

/** Request a browser download while retaining the Blob URL long enough for mobile consumers. */
export function requestBlobDownload(
  blob: Blob,
  filename: string,
  dependencies: TranscriptDownloadDependencies = browserDependencies,
): void {
  const url = dependencies.createObjectUrl(blob);
  try {
    const anchor = dependencies.createAnchor();
    try {
      anchor.href = url;
      anchor.download = filename;
      anchor.hidden = true;
      dependencies.appendAnchor(anchor as unknown as HTMLElement);
      anchor.click();
    } finally {
      anchor.remove();
    }
  } finally {
    dependencies.schedule(() => dependencies.revokeObjectUrl(url), 60_000);
  }
}

export const requestTranscriptDownload = requestBlobDownload;
