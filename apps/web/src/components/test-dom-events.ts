import { Window as HappyDomWindow } from "happy-dom";

// Converted DOM tests import this module before `react-dom/client`; React 19 initializes its event
// environment at module load, so a document must exist before that import runs.
if (typeof document === "undefined") {
  const bootstrapWindow = new HappyDomWindow({ url: "http://localhost/" });
  for (const [name, value] of Object.entries({
    window: bootstrapWindow,
    document: bootstrapWindow.document,
    navigator: bootstrapWindow.navigator,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
}

type SimulatedEventInit = Record<string, unknown> & {
  target?: object;
};

function prepareEventInit(
  element: Element,
  init: SimulatedEventInit = {},
  prepareChangeTarget = false,
): Record<string, unknown> {
  const changeTarget = init.target ?? (prepareChangeTarget ? element : undefined);
  if (changeTarget) {
    const target = changeTarget;
    const keys = target === element
      ? ["value", "checked"].filter((key) => key in target)
      : Object.keys(target);
    for (const key of keys) {
      const value = Reflect.get(target, key);
      const ownSetter = Object.getOwnPropertyDescriptor(element, key)?.set;
      const prototypeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), key)?.set;
      if (ownSetter && prototypeSetter && ownSetter !== prototypeSetter) {
        const trackerValue = key === "checked" ? !value : `${String(value)}__before_simulated_change__`;
        ownSetter.call(element, trackerValue);
        prototypeSetter.call(element, value);
      } else if (prototypeSetter) prototypeSetter.call(element, value);
      else Reflect.set(element, key, value);
    }
  }
  const { target: _target, ...eventInit } = init;
  return { bubbles: true, cancelable: true, ...eventInit };
}

function dispatch(element: Element, event: Event): void {
  element.dispatchEvent(event);
}

function eventWindow(element: Element): Window & typeof globalThis {
  const view = element.ownerDocument?.defaultView;
  if (!view) throw new Error("simulated event target is not attached to a document window");
  return view as Window & typeof globalThis;
}

/** Browser-observable DOM events for React component tests. */
export const fireDomEvent = {
  change(element: Element, init?: SimulatedEventInit): void {
    const inputType = element.localName === "input" ? element.getAttribute("type")?.toLowerCase() : null;
    const type = inputType === "checkbox" || inputType === "radio"
      ? "click"
      : element.localName === "select" ? "change" : "input";
    const view = eventWindow(element);
    const EventConstructor = type === "input" ? view.InputEvent : view.Event;
    dispatch(element, new EventConstructor(type, prepareEventInit(element, init, true)));
  },
  click(element: Element, init?: SimulatedEventInit): void {
    dispatch(element, new (eventWindow(element).MouseEvent)("click", prepareEventInit(element, init)));
  },
  compositionEnd(element: Element, init?: SimulatedEventInit): void {
    dispatch(element, new (eventWindow(element).CompositionEvent)("compositionend", prepareEventInit(element, init)));
  },
  compositionStart(element: Element, init?: SimulatedEventInit): void {
    dispatch(element, new (eventWindow(element).CompositionEvent)("compositionstart", prepareEventInit(element, init)));
  },
  keyDown(element: Element, init?: SimulatedEventInit): void {
    dispatch(element, new (eventWindow(element).KeyboardEvent)("keydown", prepareEventInit(element, init)));
  },
  pointerDown(element: Element, init?: SimulatedEventInit): void {
    const view = eventWindow(element);
    const EventConstructor = view.PointerEvent ?? view.MouseEvent;
    dispatch(element, new EventConstructor("pointerdown", prepareEventInit(element, init)));
  },
  select(element: Element, init?: SimulatedEventInit): void {
    const document = element.ownerDocument;
    document.dispatchEvent(new (eventWindow(element).Event)(
      "selectionchange",
      prepareEventInit(element, init),
    ));
  },
  submit(element: Element, init?: SimulatedEventInit): void {
    dispatch(element, new (eventWindow(element).Event)("submit", prepareEventInit(element, init)));
  },
  wheel(element: Element, init?: SimulatedEventInit): void {
    dispatch(element, new (eventWindow(element).WheelEvent)("wheel", prepareEventInit(element, init)));
  },
};
