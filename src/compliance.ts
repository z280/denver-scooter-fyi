import { fetchCompliance, NoDataError } from "./api.ts";
import { COMPLIANCE_THRESHOLD } from "./config.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export async function renderCompliance(root: HTMLElement): Promise<void> {
  try {
    const data = await fetchCompliance();
    const pct = data.avg_percent_all_devices_v1;
    const pass = data.compliance_v1_pass;

    const card = el("div", "compliance__card");

    const head = el("div", "compliance__head");
    head.append(
      el("span", "compliance__title", "Equity compliance"),
      el(
        "span",
        `compliance__pill ${pass ? "is-pass" : "is-fail"}`,
        pass ? "PASS" : "FAIL",
      ),
    );

    const value = el("div", "compliance__value", `${pct.toFixed(1)}%`);
    value.append(el("span", "compliance__unit", " of devices in Disadvantaged Areas (v1)"));

    const bar = el("div", "compliance__bar");
    bar.setAttribute("role", "img");
    bar.setAttribute(
      "aria-label",
      `${pct.toFixed(1)} percent of devices in disadvantaged areas, against a ${COMPLIANCE_THRESHOLD} percent target. Status: ${pass ? "passing" : "failing"}.`,
    );
    const fill = el("div", `compliance__fill ${pass ? "is-pass" : "is-fail"}`);
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    const threshold = el("div", "compliance__threshold");
    threshold.style.left = `${COMPLIANCE_THRESHOLD}%`;
    threshold.title = `${COMPLIANCE_THRESHOLD}% target`;
    bar.append(fill, threshold);

    const foot = el(
      "div",
      "compliance__foot",
      `Target ≥ ${COMPLIANCE_THRESHOLD}% · SLA window ${data.sla_date}`,
    );

    card.append(head, value, bar, foot);
    root.replaceChildren(card);
  } catch (err) {
    const card = el("div", "compliance__card");
    card.append(el("span", "compliance__title", "Equity compliance"));
    if (err instanceof NoDataError) {
      card.append(
        el("span", "compliance__pill is-pending", "PENDING"),
        el(
          "div",
          "compliance__foot",
          "Yesterday's 6–9am SLA window hasn't been computed yet.",
        ),
      );
    } else {
      card.append(
        el("div", "compliance__foot", "Compliance data is temporarily unavailable."),
      );
    }
    root.replaceChildren(card);
  }
}
