# SWEEP: Design System

The visual language combines **cinematic urban cartography**, **editorial typography** and **precision instruments**, with one botanical signature. Every colour carries meaning. The tokens live in `apps/web/src/styles/tokens.css`.

## Themes

| Token | Velvet (default, royal night) | Porcelain (cream daylight) |
|---|---|---|
| `--bg` | `#1D0F2E` royal aubergine | `#F4F0E8` warm porcelain |
| `--bg-deep` | `#160A24` | `#EBE4D8` |
| glows | wine magenta `rgba(176,52,118,.38)`, royal violet `rgba(104,62,196,.30)`, champagne | rose, lavender, gold washes |
| `--surface` / `-2` / `-3` | `#24133A` / `#2C1846` / `#372054` | `#FBF8F2` / `#F2ECE2` / `#E8DFD2` |
| `--line` | champagne-gold hairlines `rgba(233,201,140,.15)` | plum ink `rgba(64,33,76,.13)` |
| `--text` | `#F6EFE6` | `#24152F` (plum ink, never pure black) |
| `--accent` | champagne gold `#E9C98C` | deep plum `#2C1A3A`, with gold text |

Velvet is deliberately **not** blue-black, pure black or brown. It is a deep aubergine with violet and wine glows and gold hairlines. Porcelain renders the city as a white architectural model.

## Semantic colours (shared by 2D, 3D and reports)

| Meaning | Token | Velvet | Porcelain | Non-colour cue |
|---|---|---|---|---|
| Required street | `--required` | `#F1E6D6` | `#2C1A3A` | thick stroke |
| Optional street | `--optional` | `#7D6F8F` | `#A99DB0` | thin stroke |
| Optimised route | spectral loop (`lib/spectral.ts`) | rose → gold → cyan → lavender → coral | the same loop in deeper inks | moving light band and order markers |
| Fleet vehicle routes | spectral loop tinted per vehicle | – | – | vehicle number on the marker and in the deck |
| Repeated traversal | `--repeat` | coral `#FF6D86` | `#D23C5A` | **striped**, drawn on its own outer lane, "×n" label |
| Deadhead (optional, driven) | `--repeat` | coral | – | **dashed** |
| One-way street | street colour | – | – | arrows on the road surface (3D) and the stroke (2D) |
| Odd-degree intersection | `--odd` | lavender `#B7A6FF` | `#6148D1` | ring around the vertex |
| Matching / auxiliary graph | `--match` | gold | antique gold | dashed chord |
| Start | `--depot` | gold | antique gold | diamond with a "START" label |

A legend on the canvas explains every mark. Decorative petals use the rose family only, so they never resemble route colours.

## Typography

* **Space Grotesk:** headings and the wordmark.
* **Instrument Serif italic:** editorial accent words ("*intelligent*", "*tour*").
* **Inter:** interface text.
* **JetBrains Mono:** distances, coordinates, algorithm states and eyebrows (`tabular-nums`).

All fonts are bundled through `@fontsource`; there are no external font requests. The type scale is set by `--text-xs` through `--text-hero`, the latter being `clamp(3rem, 7.2vw, 6.6rem)`.

## Space, shape, surfaces

* **Spacing:** 4-point scale (`--space-1` 4 px through `--space-10` 144 px).
* **Radii:** 3, 6, 10, 16 px and pill.
* **Surfaces:** the workspace is one long page. Its analytical surfaces C–I follow the full-bleed simulation and are separated by fine dividers, not card grids. Hairline glass panels (`--surface-glass` plus blur) are used only for instruments floating over a canvas: the camera tools, inspector, legend, playback deck and tool dock.
* **Dimensional typography:** surface titles (`dim-title`) are extruded with five stacked one-pixel text shadows in theme inks plus a soft drop shadow, and each surface opens with a monospace eyebrow (`B · Urban simulation`).

## Motion

* **Durations:** 140, 280 and 640 ms, with an `--ease-out` of `cubic-bezier(.16, 1, .3, 1)`.
* **Purposeful motion only:** route drawing, the vehicle, odd-vertex pulse, marching connector dashes, section reveals.
* **The spectral loop** is the slow iridescent signature: rose → gold → cyan → lavender → coral. It marks *the route and its motion* and nothing else: the wordmark, the hero word "route.", the ring of the primary action and the header mini player, the hero route tube, and the workspace route in 3D, the projection and the ribbon.
* **Reduced motion:** `prefers-reduced-motion` or the user's "Pause motion" toggle removes all animation, disables the botanical field and shows the finished route.

## Signature effects

* **BotanicalCursorField** (`components/botanical/`): cherry petals drawn with procedural Bézier shapes and a notched tip (pre-rendered sprites, three tints), plus a tapering iridescent ribbon and sparks. Petals are emitted per distance travelled, from a pool of at most 150 petals, 110 sparks and 4 blooms. The canvas has `pointer-events: none`; the loop sleeps when idle or hidden; the field is disabled for touch-first devices and reduced motion.
* **Bloom:** clicking empty space inside `[data-bloom-zone]` (the hero and the closing section, but never controls or text) unfolds two rings of petals with a soft radial glow, rotation and sparks, then fades out.
* **Spectral route shader** (`three/materials.ts`). Every vertex of the route tube carries its **true route distance** (`aDist`) and traversal kind (`aKind`: service, repeat or deadhead). The fragment shader computes everything from `aDist` measured against the playback head, so the light follows the computed order exactly and never jumps:
  * the colour loop and a travelling light band;
  * a bright leading highlight at the vehicle;
  * a trail that fades behind it, and a faint "ghost" of the road still ahead;
  * stripes for repeats and discarded dashes for deadheads.

  An additive halo tube (normal blending in Porcelain) and up to 140 spectral motes add atmosphere under restrained bloom. Repeated passes and opposite directions are drawn on separate lanes, offset to the right of travel. Under reduced motion the band stops and the frame renders on demand; without WebGL the 2D projection takes over the stage with the same palette.
* **3D district** (`three/district.ts`). Procedural, deterministic and generated from the network data:
  * roads with sidewalks and dashed centre lines, and one-way arrows;
  * junction plates you can pick;
  * buildings aligned to their nearest street, in several archetypes, with a facade window shader that is lit in Velvet and a crisp white model in Porcelain;
  * blossom trees.

  Buildings are context, not data, and the legend says so. Shadows, bloom and the vignette degrade automatically on slow GPUs. Software rasterisers start in low-power mode, which draws frames only while the route plays or the camera moves.
* **Blossom zones.** `data-petal-intensity` on an element scales the cursor field over it. The simulation uses 0.7 and the editor 0.2; nothing is emitted while you drag in the editor. The field never takes pointer events.

## Components

`btn` (`--primary`, `--quiet`, `--ghost`, `--danger`, `--spectral`, sizes `sm` and `lg`), `input` and `select`, `switch`, `segmented` (tabs and toggles), `chip` (ok, warn, danger, accent, odd), `kbd`, `dialog` (focus trap, Escape, focus return), `toast` (polite live region; errors use alert), CSS `data-tip` tooltips, `spinner`, `empty-state`, `notice` (info, warn), `table`, `diag` (error, warning, info), `checks`, `bars`, `instrument` (monospace readout strip).

## Accessibility rules

* Every interactive element is a native control with a visible `:focus-visible` ring (`--focus`).
* Text contrast meets WCAG AA in both themes. This is verified by axe in the end-to-end suite.
* Colour is never the only signal: dashes, rings, labels and "×n" counts duplicate it.
* The canvas has a descriptive label and keyboard pan and zoom. All editing can also be done from the keyboard through the Streets table dialog and the Inspector.
* The 3D view and the cursor field are optional: the 2D canvas carries all information.

## Don'ts

Do not add rows of identical stat cards, purple gradient buttons, glow on everything, decorative globes, random moving vehicles, or charts without data. Do not scatter rainbow colour: the spectral loop stays confined to the places listed above.
