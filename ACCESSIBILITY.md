# Accessibility

DK-Agents is at an early stage and does not yet meet a formal accessibility standard. This page says honestly what
works, what does not, and how to tell us about barriers.

## Current state

- **Supported environment:** Linux desktop (developed on Fedora), distributed as an AppImage.
- **Keyboard:** the chat composer works from the keyboard (Enter sends, Shift+Enter adds a line). Many other parts of
  the interface — especially the pixel-art office — still need a mouse.
- **Known limitations:** the office view is a canvas without a text alternative; the pixel fonts and some colour
  combinations may be hard to read; screen-reader support has not been tested.

## Goal

The chat, task board, git and settings views should be fully usable with a keyboard and a screen reader, and readable
at larger text sizes, independently of the office view. This is part of the interface work in the later stages.

## Reporting a barrier

Open an issue with the *Bug report* template and mention "accessibility" in the title. Describe what you tried to do,
what assistive technology you use (if any), and what got in the way.
