# Owner decision: do the feature pills get their words back?

**Status:** open. One question, two documents that disagree, nothing else in
§12.3 blocked behind anything else.

This file exists because the question was asked in a sentence buried in
`ALONG_THE_WAY_PLAN.md` §12.3 and could not be answered from that sentence
alone — the argument on the other side lives in a CSS comment three thousand
lines into `style.css`, and the precedent both sides cite lives in a third
file. All of it is copied here verbatim so the decision can be made from one
page.

---

## 1. What is on screen today

The device card's header carries the scooter's name, then a row of feature
pills. Each pill is a 30 px circle with **a glyph and no text** —
`.device-popup__feature` in `src/style.css`, built by `featureBlock` in
`src/devices.ts`:

```html
<button type="button" class="device-popup__feature" aria-label="<full sentence>">
  <span class="device-popup__feature-glyph" aria-hidden="true">🧺</span>
</button>
```

Tapping one writes its full sentence into `.device-popup__feature-why`, a
`role="status"` live region. A broken feature keeps its pill and gains
`is-broken`: dashed border, dimmed, struck through — *"that it is THERE and
BUST is more useful than either half alone."*

So today: glyph on the card, words on tap, words in the `aria-label`, words in
the stat list's prose row.

## 2. What §12.3 asked for

The drawn card in the plan, verbatim:

```
┌────────────────────────────────────────────┐
│  🛴  Lunar 🐸 928            [Veo Cosmo]   │   ← name + model badge
│      Seated · two wheels                   │
├────────────────────────────────────────────┤
│  ✅ Likely rideable                         │   ← the verdict bar, unchanged
├────────────────────────────────────────────┤
│  🔋 82%   ·   ~6.2 mi left                  │   ← ONE facts strip, big
│  🧺 basket  📱 phone holder  🔔 bell (!)    │   ← features, WITH WORDS
├────────────────────────────────────────────┤
│  ~4 min walk (0.2 mi)                       │
├────────────────────────────────────────────┤
│  [ 🛴 I'll ride this one        ]           │   ← one primary
│  [ ▶️ Open in Veo ] [ ☑️ Features ]         │
│  ⚠️ Report   ℹ️ Details   📷 Photos          │   ← secondary, one row, small
└────────────────────────────────────────────┘
```

and the bullet, verbatim:

> - **Features get their words back**, and the broken ones keep the `(!)` they
>   already have. A glyph is not a label (`emoji-scale.ts` had to learn the same
>   thing).

## 3. What the code says back

`src/style.css`, above `.device-popup__feature`, verbatim:

> ```
> /* GLYPH ONLY. The names were three words of chrome on the busiest line of
>    the card; the icon is the recognisable part and the name is one tap away in
>    the explanation, which says more than a label could anyway. The full
>    sentence is still the button's aria-label, so nothing is lost to a screen
>    reader.
>
>    Translucent white on the turquoise rather than a panel colour — it reads as
>    part of the header rather than as controls dropped on top of it. */
> ```

Two more comments in the same block matter, because they are why the pills are
in the header at all:

> ```
> /* Between the name and the verdict: what this scooter HAS, which is what a
>    rider chooses between two nearby ones with. */
> ```

> ```
> /* Inside the turquoise header now, under the name — these are part of what
>    this scooter IS, so they belong with its identity rather than in a strip
>    of their own between two coloured bars. */
> ```

That last one is a second, quieter disagreement with §12.3: the plan draws the
pills **below** the verdict bar as part of a facts strip; the code puts them
**above** it, inside the identity block. The labels question and the position
question are the same change.

## 4. The precedent each side claims

§12.3 cites `emoji-scale.ts` — "a glyph is not a label" — and that is a real
lesson learned in this codebase. But the shapes differ:

- **`emoji-scale.ts`**: a glyph carrying meaning with **no words available
  anywhere**. The reader either decodes the emoji or gets nothing.
- **the feature pills**: a glyph with words in the `aria-label`, in the tapped
  explanation, and in the stat list's prose row. The words are one tap, or
  zero taps with a screen reader.

So the precedent does not transfer cleanly. It argues against glyph-only when
glyph-only means wordless, and the pills are not wordless.

## 5. The honest case on each side

**Keep glyph-only (what shipped, the later decision):**
- The header is the tightest line on the card: name, 🐸 emoji, model badge, and
  then the pills. Three or four two-word labels wrap it to three lines.
- Nothing is lost to assistive tech; the `aria-label` is the full sentence.
- The tapped explanation says more than a label could — a label says "bell", the
  explanation says what it means for this ride.
- Four 30 px circles are a stable, scannable shape at a glance; four
  variable-width text pills are not.

**Give the words back (what §12.3 asked):**
- A sighted rider choosing between two scooters in a hurry should not have to
  tap to learn what one has. The whole point of the row is comparison.
- 🧺 is not universally "basket" and 📱 is not universally "phone holder"; the
  broken-pill treatment (dashed, struck) is also easier to misread without a
  word beside it.
- §12.3's own ordering argument — *decide first, act second* — wants these as
  **facts**, which are text, rather than as **controls**, which is what a row of
  circles looks like.
- "One tap away" costs a tap per feature per scooter, on the screen a rider is
  on most.

## 6. Why this was not decided without the owner

The labels came off **after** §12.3 was written, deliberately, with the
reasoning recorded. So this is not a bug left behind: it is two documents
disagreeing, the later one being the code. Flipping it back would be the older
document losing on recency rather than on argument, and flipping it forward
would be the newer one winning for the same bad reason. It is a judgement call
about a busy line, with no correctness defect on either side.

## 7. What the answer unblocks

| Choice | Follow-on work |
|---|---|
| **Keep glyph-only** | Close §12.3's labels bullet as superseded, and build the single facts strip **around glyph pills** — battery + range as the text row, pills staying in the header. Half a day. |
| **Give the words back** | Labels return to `featureBlock`; pills move out of the turquoise header into the facts strip below the verdict bar (they will not fit in the header with text); `.device-popup__feature` becomes a text pill; the strike-through broken treatment is re-tuned for a labelled pill. One change, not two — the position and the words go together. |

Either answer finishes §12.3. Everything in that section that does not depend
on this has already shipped: `Vehicle ID` and `Parked for` are in `ℹ️ Details`,
the action hierarchy is one primary plus a text-sized secondary row, and §12.4's
one-handler blocked-reason mechanism is in.

## 8. Sources

- `docs/ALONG_THE_WAY_PLAN.md` §12.3 — the drawn card, the labels bullet, and
  the note recording this as the owner's call.
- `src/style.css`, `.device-popup__features` / `.device-popup__feature` — the
  glyph-only reasoning and the header-placement reasoning.
- `src/devices.ts`, `featureBlock` — the pill markup, the `aria-label`, and the
  `is-broken` treatment.
- `src/emoji-scale.ts` — the precedent §12.3 cites.
