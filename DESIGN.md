# Design

Visual system for Kashu: how it looks and moves. Direction A, "Shutters".

## Scene

Amaka, 27, on a danfo in Lagos at five in the afternoon on payday, sun hard on the window, phone at arm's length, checking whether her friends have saved before she puts hers in. Light theme, large type, high contrast, one thumb, one thing per screen. Draw night is a different scene (evening, sofa, group chat), the licence for the one dusk moment a week.

## Signature

- **The kernel K.** A cashew kernel forms the K's arms and a sprouting leaf its stem. Flat mark inside the app; the glossy 3D mark is for marketing only.
- **The wall of windows.** A room is a wall; each friend is a window that lights (Kernel yellow) once they have saved this payday. You see the light, never the inside. Each window also carries its own shutter pattern (louvre, panel, lattice, grid) so nothing depends on colour.
- **The moon.** The kernel curve doubles as the crescent moon of draw night.

## Colour (Committed)

| Token | Value | Use |
|---|---|---|
| canopy | #0D5A3B | brand surfaces, primary buttons, headers |
| canopy-deep | #08402A | pressed, bars, text on mist |
| paper | #F6F7F1 | background (never pure white, never cream) |
| mist | #E4EADF | secondary surfaces, unlit windows |
| shell | #1E231B | text and icons |
| muted | #464D41 | secondary text |
| apple | #E8472F | celebration accents only, never text |
| apple-deep | #B8301C | coral buttons carrying text |
| kernel | #F5CF5E | "the light is on" (saved), streaks, the moon |
| leaf | #3E8E5E | success marks, not text |
| dusk | #16263A | draw night only |
| moonlight | #EEF2F6 | text on dusk |


## Type

- Display: **Jaro** (headlines, big numerals, wordmark). Text: **Andika** (everything read). Both carry the full Yorùbá and Igbo set.
- Scale (rem, ratio about 1.25 to 1.33): 0.875 label, 1.0625 body (17px), 1.25, 1.625, 2.125, 2.875, 3.75 to 5.5 hero (clamp).
- Tabular numerals for money and streaks. Body 65 to 75ch on the landing.

## Shape and space

- Radii: 12 (controls), 20 (panels), 28 (sheets), windows 14.
- Spacing in rem on a 4px base, varied for rhythm; no uniform padding everywhere.
- No glass, no gradient text, no side-stripe borders, no identical card grids, no nested cards.

## Motion

- Tokens: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` (quint-like), `--ease-expo: cubic-bezier(0.16, 1, 0.3, 1)`, `--ease-inout: cubic-bezier(0.77, 0, 0.175, 1)`, `--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1)`.
- Product UI under 300ms; press scale 0.97 on :active. Windows open from their hinge edge (rotateY, 220ms). Hold-to-save fills linearly while held, snaps back in 200ms if released early. The withdraw sheet tracks the finger 1:1 and settles with a small release bounce (allowed for Kashu on drag release only).
- Draw night is the one long sequence (about 2.5s): wall to dusk, a light travels window to window and rests. Result is known before it plays; Skip is always there; Calm draw replaces it with a fade.
- Landing: first-visit hero sequence up to 600ms total; one scroll-driven moment (the week on the wall); idle loops only with a pause control.
- transform and opacity only (clip-path allowed). prefers-reduced-motion: keep fades and colour, drop movement.

## Mobile floor

viewport-fit=cover, interactive-widget=resizes-content, 100dvh shell, safe-area insets, inputs at 16px or more with the numeric keypad, hover only under (hover: hover) and (pointer: fine), touch-action: manipulation, no tap highlight, overscroll-behavior: none on the shell, theme-color per scene, never user-scalable=no. Tap targets 48px.
