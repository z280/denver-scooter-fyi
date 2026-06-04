import { commas, denverTime } from "./util.ts";

export class Freshness {
  private snapshotTime: string | null = null;
  private visibleCount = 0;
  private totalCount = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly textEl: HTMLElement,
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
    this.textEl.textContent = `as of ${denverTime(this.snapshotTime)} · Displaying ${commas(this.visibleCount)} devices out of ${commas(this.totalCount)}`;
  }

  error(): void {
    this.root.classList.add("is-stale");
    this.textEl.textContent = "live data unavailable — retrying";
  }
}
