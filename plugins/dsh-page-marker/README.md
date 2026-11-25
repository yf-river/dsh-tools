---
description: "Mark elements in a controlled browser, then insert what you saw into the conversation."
kind: "package-reference"
---

# @yf-river/dsh-page-marker

Browser half of the annotation workflow: a right-sidebar tab that renders a
controlled Chromium, plus an annotation layer that outlines each element under
the pointer and turns a batch of marked elements into one message.

## Why a controlled browser

An iframe cannot be scripted when it is cross-origin, and many sites refuse to
be framed at all (`X-Frame-Options`, CSP `frame-ancestors`). A browser this
plugin launches has neither limitation: any address loads, and the DOM of any
page is readable through the DevTools protocol.

## How it works

| Piece | Responsibility |
|---|---|
| `browser.mjs` | Launches Chromium, owns the CDP session, streams frames, forwards input, reads elements |
| `annotate.js` | Runs inside the page: hover outline, size badge, element facts |
| `index.js` | HTTP API under `/plugin/page-marker/browser/*` |
| `client.js` | The sidebar tab: address bar, pointer tool, note cards, batch insert |

Output is MJPEG over HTTP (`multipart/x-mixed-replace`), which an `<img>` already
renders; input is ordinary `POST` requests, which need no reconnection logic for
an event rate this low.

## Using it

1. Press the globe in the conversation header to open a browser tab.
2. Enter an address, then press the pointer tool.
3. Hover any element — it gets a blue outline and a size badge.
4. Click it, type what looks wrong, and save. Repeat for more elements.
5. Press the list tool, then "Insert into composer" to send them all at once.

The outline is drawn inside the page, so what you see is part of the frame
rather than a box drawn over a video.

## Limits

- Sessions and cookies start empty each time a browser is launched from a tab.
- Each tab owns one Chromium; closing the tab closes the process and deletes
  its temporary profile.
- Keyboard input reaches the page only through a focused field; typing into the
  page directly is not forwarded yet.
