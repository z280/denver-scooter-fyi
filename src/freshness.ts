import { commas, denverTime } from "./util.ts";

/** The bottom-right status pill: two compact lines —
 *    (dot) Data Timestamp: HH:MM
 *    Showing: 0,000 / 0,000 Devices
 */
export class Freshness {
  private snapshotTime: string | null = null;
  private visibleCount = 0;
  private totalCount = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly timeEl: HTMLElement,
    private readonly countEl: HTMLElement,
  ) {}

  update(snapshotTime: string, visibleCount: number, totalCount: number): void {
    this.snapshotTime = snapshotTime;
    this.visibleCount = visibleCount;
    this.totalCount = totalCount;
    this.render();
  }

  /** Refresh just the visible-count portion (filter change, same snapshot). */
  setCounts(visibleCount: number, totalCount: number): void {
    this.visibleCount = visibleCount;
    this.totalCount = totalCount;
    if (this.snapshotTime) this.render();
  }

  private render(): void {
    if (!this.snapshotTime) return;
    this.root.classList.remove("is-stale");
    this.timeEl.textContent = `Data Timestamp: ${denverTime(this.snapshotTime)}`;
    this.countEl.hidden = false;
    this.countEl.textContent = `Showing: ${commas(this.visibleCount)} / ${commas(this.totalCount)} Devices`;
  }

  error(): void {
    this.root.classList.add("is-stale");
    this.timeEl.textContent = "live data unavailable — retrying";
    this.countEl.hidden = true;
  }
}
