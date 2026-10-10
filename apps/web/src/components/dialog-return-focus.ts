import { createContext, type RefObject } from "react";

/** An opener retained while a loading dialog is replaced by its loaded content. */
export const DialogReturnFocusContext = createContext<RefObject<HTMLElement | null> | null>(null);
