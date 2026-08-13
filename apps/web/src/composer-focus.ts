export function placeComposerCaretAtEnd(
  element: HTMLTextAreaElement,
  isComposing = false,
): boolean {
  if (isComposing) return false;
  const end = element.value.length;
  element.setSelectionRange(end, end);
  element.scrollTop = element.scrollHeight;
  return true;
}

export function focusComposerAtEnd(
  element: HTMLTextAreaElement,
  isComposing = false,
): boolean {
  if (element.ownerDocument.activeElement === element) return false;
  element.focus();
  return placeComposerCaretAtEnd(element, isComposing);
}
