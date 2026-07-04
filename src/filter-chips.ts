// Active-filter chips: an always-visible row floating over the map with one
// chip per live constraint, each with a ✕ that resets the underlying
// control. Fixes the "out of sight, out of mind" drawer problem — users
// forget a filter is on and wonder why the map looks empty.

export interface Chip {
  /** Stable identity for the constraint (e.g. "device-type", "battery"). */
  id: string;
  /** Short human-readable text, e.g. "🛴 Scooters". */
  label: string;
  /** Reset the underlying control. The caller re-renders afterwards. */
  onClear: () => void;
}

export class FilterChips {
  constructor(private readonly root: HTMLElement) {}

  /** Replace the chip row with the given set. Empty hides the row. */
  render(chips: Chip[]): void {
    this.root.replaceChildren();
    this.root.hidden = chips.length === 0;
    for (const chip of chips) {
      const el = document.createElement("span");
      el.className = "chip";
      el.dataset.chip = chip.id;

      const label = document.createElement("span");
      label.className = "chip__label";
      label.textContent = chip.label;

      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "chip__clear";
      clear.setAttribute("aria-label", `Clear filter: ${chip.label}`);
      clear.textContent = "×";
      clear.addEventListener("click", chip.onClear);

      el.append(label, clear);
      this.root.append(el);
    }
  }
}
