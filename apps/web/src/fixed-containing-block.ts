/**
 * How far the box a `position: fixed` element resolves against is from the viewport, for an element
 * placed as a child of `host`.
 *
 * Normally that box is the viewport and every offset is 0. An ancestor with a transform, a filter or
 * layout containment becomes the box instead, and the element's `top`, `left` and `bottom` then count
 * from that ancestor's edges. At the build floor (docs/design-system.md §2.10) `container-type`
 * applies layout containment, so the main column's `app` container is such an ancestor for every
 * surface inside it. A surface placed in viewport coordinates subtracts these offsets, and no
 * ancestor can move it.
 *
 * Measured with a probe rather than derived from computed styles, because which properties create
 * the box has changed between engine versions and the floor spans several of them. The probe is a
 * sibling of the element being placed, so it shares that element's ancestors. It is inserted and
 * removed in the same task and never paints. Because inserting it forces a layout, callers measure
 * only when their surface opens or its anchor has moved, never on a scroll or resize that moved
 * nothing, and never on every frame.
 */
export interface FixedContainingBlockOffset {
  /** The box's left edge in viewport coordinates. */
  left: number;
  /** The box's top edge in viewport coordinates. */
  top: number;
  /** The distance from the box's bottom edge up to the viewport's bottom edge. */
  bottom: number;
}

const NO_OFFSET: FixedContainingBlockOffset = { left: 0, top: 0, bottom: 0 };

export function fixedContainingBlockOffset(host: Element | null | undefined): FixedContainingBlockOffset {
  const view = host?.ownerDocument.defaultView;
  if (!host || !view) return NO_OFFSET;
  const probe = host.ownerDocument.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:100%;margin:0;border:0;padding:0;"
    + "visibility:hidden;pointer-events:none";
  host.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  // A box always has a height here (100% of the box it resolves against), so none means there was
  // no layout at all: a DOM without a rendering engine, or a host that is not rendered.
  if (rect.height === 0) return NO_OFFSET;
  return { left: rect.left, top: rect.top, bottom: view.innerHeight - rect.bottom };
}
