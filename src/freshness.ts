import { commas, denverTime } from "./util.ts";

/** The bottom-right status pill: three compact lines —
 *    (dot) Data Timestamp: HH:MM
 *    Filters: 0,000 / 0,000 Devices
 *    Map: 0,000 Devices Visible
 *  The Filters line tracks the filtered fleet against the total; the Map
 *  line counts filtered devices inside the current viewport (fed by
 *  main.ts on every map move and data/filter change). */
export class Freshness {
  private snapshotTime: string | null = null;
  private visibleCount = 0;
  private totalCount = 0;
  private viewportCount = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly timeEl: HTMLElement,
    private readonly countEl: HTMLElement,
    private readonly mapEl: HTMLElement,
  ) {}

  update(snapshotTime: string, visibleCount: number, totalCount: number): void {
    this.snapshotTime = snapshotTime;
    this.visibleCount = visibleCount;
    this.totalCount = totalCount;
    this.render();
  }

  /** Refresh just the filtered-count portion (filter change, same snapshot). */
  setCounts(visibleCount: number, totalCount: number): void {
    this.visibleCount = visibleCount;
    this.totalCount = totalCount;
    if (this.snapshotTime) this.render();
  }

  /** How many filtered devices sit inside the current viewport. */
  setViewportCount(n: number): void {
    this.viewportCount = n;
    if (this.snapshotTime) this.render();
  }

  private render(): void {
    if (!this.snapshotTime) return;
    this.root.classList.remove("is-stale");
    this.timeEl.textContent = `Data Timestamp: ${denverTime(this.snapshotTime)}`;
    this.countEl.hidden = false;
    this.countEl.textContent = `Filters: ${commas(this.visibleCount)} / ${commas(this.totalCount)} Devices`;
    this.mapEl.hidden = false;
    this.mapEl.textContent = `Map: ${commas(this.viewportCount)} Devices Visible`;
  }

  error(): void {
    this.root.classList.add("is-stale");
    this.timeEl.textContent = "live data unavailable — retrying";
    this.countEl.hidden = true;
    this.mapEl.hidden = true;
  }
}
