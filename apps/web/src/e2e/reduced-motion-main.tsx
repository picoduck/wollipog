import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MenuItem, MenuSurface } from "../components/Menu.js";
import { SearchableCombobox } from "../components/ui/ChoiceControls.js";
import "../styles.css";

/**
 * The global reduced-motion guard (#2574) against real stylesheet rules, in a real browser: the
 * question is which property changes start a CSS transition, and only a browser's style engine
 * answers that.
 *
 * - A transcript bubble declares no transition, so a change to it must apply in the same frame.
 * - A directory entry declares a background-color transition, which must still run and end.
 * - A menu declares an entrance animation, and re-places itself on `animationend` (Menu.tsx).
 * - A combobox's list re-places itself on `animationend` too (interactions.ts).
 */
function Harness() {
  document.documentElement.setAttribute("data-theme", "dark");
  const [menuOpen, setMenuOpen] = useState(false);
  const [fruit, setFruit] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  return (
    <main style={{ display: "grid", gap: 24, padding: 24, maxWidth: 480 }}>
      <div className="tl-bubble" data-testid="undeclared">A bubble with no transition of its own.</div>
      <div className="dir-entry" data-testid="declared">A row that declares a transition.</div>
      <div>
        <button type="button" className="btn" ref={triggerRef} onClick={() => setMenuOpen(true)}>Open Menu</button>
        {menuOpen && (
          <MenuSurface
            surfaceRef={surfaceRef}
            anchor={{ trigger: triggerRef }}
            label="Actions"
            onDismiss={() => setMenuOpen(false)}
          >
            <MenuItem onClick={() => setMenuOpen(false)}>Rename</MenuItem>
          </MenuSurface>
        )}
      </div>
      <SearchableCombobox<string>
        label="Fruit"
        value={fruit}
        onChange={setFruit}
        noun="fruits"
        options={[
          { value: "apple", label: "Apple" },
          { value: "pear", label: "Pear" },
          { value: "plum", label: "Plum" },
        ]}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
