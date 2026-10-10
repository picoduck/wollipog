import { Suspense, useState, type ReactNode } from "react";
import { DialogReturnFocusContext } from "./dialog-return-focus.js";
import { Modal } from "./Modal.js";
import { State } from "./State.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

export function LazyDialogBoundary({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // Capture before the loading modal moves focus. Both versions restore the same opener.
  const [opener] = useState(() => ({
    current: typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement : null,
  }));
  return (
    <DialogReturnFocusContext.Provider value={opener}>
      <ErrorBoundary name="This Dialog" wrapError={(notice) => <Modal title={title} onClose={onClose}>{notice}</Modal>}>
      <Suspense fallback={<Modal title={title} onClose={onClose}><State variant="loading" compact>Loading…</State></Modal>}>
        {children}
      </Suspense>
      </ErrorBoundary>
    </DialogReturnFocusContext.Provider>
  );
}
