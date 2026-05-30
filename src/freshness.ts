import { commas, denverTime } from "./util.ts";

export class Freshness {
  constructor(
    private readonly root: HTMLElement,
    private readonly textEl: HTMLElement,
  ) {}

  update(snapshotTime: string, deviceCount: number): void {
    this.root.classList.remove("is-stale");
    this.textEl.textContent = `as of ${denverTime(snapshotTime)} · ${commas(deviceCount)} devices`;
  }

  error(): void {
    this.root.classList.add("is-stale");
    this.textEl.textContent = "live data unavailable — retrying";
  }
}
