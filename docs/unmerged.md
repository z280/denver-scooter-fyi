# Unmerged branches — denver-scooter-fyi

Remote branches with commits that are not on `main`, as of 2026-10-08.
Written during the 2026-10-08 branch cleanup: every branch whose work was already on
`main` (merged PR, or an ancestor of `main`) was deleted, and its tip SHA logged so it can be
restored. What is left here was **not** deleted because it holds work that is not on
`main`. Each one needs a decision: merge it, open a PR, or delete it.

This is a snapshot; it goes stale as branches change. Re-check with
`git fetch --prune && git log origin/main..origin/<branch>`.

| Branch | Last commit | Author | Ahead | Behind | PR |
|---|---|---|---|---|---|
| `claude/along-way-upgrades-feature-piml2p` | 2026-10-08 | ZekeNeill | 6 | 0 | #94 merged, #100 merged, #101 merged, #103 merged, #104 merged, #105 merged, #110 merged, #116 merged, #117 open |
| `claude/navigation-directions-improve-qzijuh` | 2026-08-18 | Claude | 3 | 172 | none |
| `claude/analytics-campaign-management-umjj87` | 2026-08-11 | ZekeNeill | 1 | 176 | none |
| `claude/multi-provider-multi-city-al0qxl` | 2026-08-04 | ZekeNeill | 4 | 307 | none |
| `worktree-ui-overhaul-plan` | 2026-07-28 | zneill | 3 | 369 | #31 merged |
| `claude/lucid-hopper-FqI5F` | 2026-06-01 | Claude | 2 | 507 | none |

## What each branch holds

Commits marked *equivalent change already on main* landed some other way (e.g. a squash
merge); a branch made only of those is safe to delete.

### `claude/along-way-upgrades-feature-piml2p`
- 18be124 Home and Work are favourite slots, not profile columns
- 3d6088f Don't push saved places to a server that never asked for them
- 993e4d6 Merge remote-tracking branch 'origin/main' into claude/along-way-upgrades-feature-piml2p
- d413f79 Saved places sync, profile above the tabs, a Navigation tab
- e8a86bc feat: a Two Passengers quick filter that actually binds the planner
- 578fd15 feat: the plan list gets room, type-first names, and a split preference

### `claude/navigation-directions-improve-qzijuh`
- 9759f4f Merge origin/main: keep main's beta-warning + tap-to-jump, graft fractional matcher
- db056fb Nav HUD: show the upcoming turn, detect turn completion by segment projection
- d01bb2a Render the API's nav-directions beta warning wherever directions show

### `claude/analytics-campaign-management-umjj87`
- c3adbf5 Capture utm_campaign for first-party campaign attribution

### `claude/multi-provider-multi-city-al0qxl`
- b7d2a5a Plan: comparator is Lime, and weekPassCents is a mislabelled hour
- 1247c3d Plan: rewrite the rate comparator around what riders actually paid
- 2d890bb Plan: COMPARATOR can be sourced from Lyft's frozen Denver feed
- 9b2d9e0 Add multi-city frontend plan

### `worktree-ui-overhaul-plan`
- 0ad122e Fold in the four interview decisions
- 0fd6510 Fix review defects; rebase the plan onto current main
- be7f3f2 Merge current main (decomm #32, #34) into the plan branch

### `claude/lucid-hopper-FqI5F`
- fb24483 Replace gated range floor with a dual-handle range slider for everyone
- c59b073 Add authenticated ≥40 km range filter and simplify mobile unlock gate
