import { Modal } from "./common.js";
import { SHORTCUT_GROUPS, SHORTCUTS, shortcutDisplay, shortcutUnavailableReason } from "../shortcuts.js";

function shortcutGroupId(group: string): string {
  return `shortcut-${group.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function ShortcutReference({
  onClose,
  sessionOpen,
  terminalSupported,
  filesSupported,
  conversationSteeringSupported,
  turnInterruptionSupported,
}: {
  onClose: () => void;
  sessionOpen: boolean;
  terminalSupported: boolean;
  filesSupported: boolean;
  conversationSteeringSupported: boolean;
  turnInterruptionSupported: boolean;
}) {
  return (
    <Modal title="Keyboard Shortcuts" onClose={onClose}>
      <p className="shortcut-intro">These bindings are shared by the app and this reference, so the list stays in step with the controls.</p>
      <div className="shortcut-groups">
        {SHORTCUT_GROUPS.map((group) => (
          <section className="shortcut-group" key={group} aria-labelledby={shortcutGroupId(group)}>
            <h3 id={shortcutGroupId(group)}>{group}</h3>
            <dl className="shortcut-list">
              {SHORTCUTS.filter((item) => item.group === group).map((item) => {
                const unavailable = shortcutUnavailableReason(item, {
                  sessionOpen,
                  terminalSupported,
                  filesSupported,
                  conversationSteeringSupported,
                  turnInterruptionSupported,
                });
                return (
                  <div className={`shortcut-row${unavailable ? " is-unavailable" : ""}`} key={item.id} aria-disabled={unavailable ? "true" : undefined}>
                    <div>
                      <dt>{item.label}</dt>
                      <dd>
                        {unavailable ?? item.description}
                        <span className="shortcut-scope">{item.scope}</span>
                      </dd>
                    </div>
                    <kbd>{shortcutDisplay(item.id)}</kbd>
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
      </div>
      <p className="shortcut-footnote">Session shortcuts are active while a session is open. App command chords are suppressed while terminal input owns focus.</p>
    </Modal>
  );
}
