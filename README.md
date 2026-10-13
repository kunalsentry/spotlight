# Spotlight

A Manifest V3 Chrome extension that spotlights part of a web page while you present it over a tab or window share (Google Meet, Zoom, and others). It works in the page's DOM, so viewers see exactly what you see.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest: permissions, the toggle shortcut, the content script, and the popup |
| `background.js` | Service worker. Sends the shortcut, right-click menu and popup actions to the active tab, injects the content script into tabs that were already open, and keeps the **ON** badge and the menu item's label up to date |
| `content.js` | The spotlight: overlay, effects, cursor following, placing, dragging, and the on-page toolbar |
| `cues.js` | Cues: recording, finding elements again, matching pages, and placing the spotlight when a cue's trigger is clicked |
| `popup.html` / `popup.js` | Two tabs: **Spotlight** (on/off switch, shape, size, effect, strength, ink, zoom) and **Cues** (arm, record, test and edit cues) |
| `cue-editor.js` / `cue-editor.css` | The cue editor, shared by the popup's Cues tab and the cue manager |
| `options.html` / `options.js` | The cue manager: every cue on one page, plus import and export |
| `icons/` | Toolbar and extension icons |

## Load it in Chrome

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this folder.
3. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Spotlight**.
4. Open `chrome://extensions/shortcuts` and check that **Toggle spotlight** is set to `⌥S` (Mac) or `Alt+S` (Windows). If you loaded an earlier version, Chrome may keep the old shortcut. Set it there, or remove the extension and load it again. On a Mac, ⌥S normally types "ß"; if you need that character, set **⌃⇧S** (Control+Shift+S) there instead.

After you edit the code, click the reload icon on the extension's card.

## Using it

1. Press **⌥S** (press it again to turn the spotlight off), flip the switch in the popup, or right-click anywhere on the page and click **Spotlight**. The spotlight follows your cursor, starting where you are (or where you right-clicked). While the spotlight is on, the menu item reads **Turn off spotlight**.
2. **Click** to place it. That click only places the spotlight; it doesn't click the page. After that, the page works normally: you can click, type and scroll, inside the spotlight or outside it.
3. **Drag** the spotlight's edge (the cursor changes to a hand) or the **⠿** handle to move it.
4. **Resize** it by dragging one of the two white squares, at the top-left and bottom-right of the outline. The opposite corner stays where it is. A circle stays a circle; a box resizes freely. When you let go, the page automatically zooms in to the newly sized area (see Zoom below), unless **After resize** is turned off in the popup; a click on a handle without dragging doesn't. This size is temporary. Going back to following the cursor (⌖) smoothly returns it to the size set in the popup, and the next time you turn the spotlight on it starts at that size.
5. The toolbar above it has **⌖**, which follows the cursor again, **🔍**, which zooms in, and **✕**, which turns the spotlight off. **⌥S** also turns it off. The toolbar normally sits above or below the spotlight. When there's no room and it has to sit over the spotlight area (for example, when a large spotlight is zoomed), it turns nearly transparent so it doesn't hide what you're showing; hover over it (or tab to it) to show it fully. It also shows fully for a moment when you place the spotlight or the zoom changes.
6. **Zoom** (the 🔍 button): the page smoothly scales up until the spotlight fills about 80% of the window, so some of the surroundings stay in view. For a large spotlight, where that would barely zoom, it zooms at least 1.25× if that fits, or otherwise as far as it can while keeping the whole spotlight on screen (with a small margin at the window edge). Zoom never crops the spotlight and is capped at 6×. It's centred when the toolbar fits above or below it; otherwise it shifts down just enough to make room for the toolbar, and if even that isn't possible the toolbar sits just inside the spotlight's top edge. If the spotlight already nearly spans the window, zoom can't magnify it without cropping, so it asks you to make the spotlight smaller. The spotlight grows with it, so it frames the same content. The page stays clickable while zoomed, and clicks land on what you see. While zoomed, the toolbar shows a labelled **Zoom out** button, kept apart from ✕ by a divider so you don't turn the spotlight off by mistake. Any spotlight interaction zooms out automatically and then carries on. Grabbing a handle or the edge while zoomed zooms out around the point you grabbed, so it stays under your cursor and the spotlight keeps its size; the page may sit slightly shifted while you drag, then glides back (or zooms in again after a resize, if **After resize** is on). ⌖ follow and changing size or shape in the popup also zoom out first. Clicking the page, or changing the effect or strength, keeps the zoom.

## Disappearing ink

Hold **⌥D** (Option+D; Alt+D on Windows) and move the mouse to draw on the page, the way Google Meet's annotations work. It works whether or not the spotlight is on. You don't need to click, so you can't click the page by accident. Let go of the keys to stop. Each part of a stroke disappears 1.5 seconds after you draw it (it stays for 1 s, then fades over 0.5 s), in the order you drew it. Ink draws over everything, including the dimmed area. Pick its colour under **Ink** in the popup.

On Windows, Chrome uses Alt+D to jump to the address bar, which may take priority over the ink shortcut.

## Cues

A cue turns the spotlight on by itself when you click a specific element on certain pages: for example, clicking **Open trace** on any issue spotlights the trace waterfall, already sized and optionally zoomed. Cues only run while they're **armed**.

Everything about cues is on the popup's **Cues** tab (the popup reopens on the tab you used last).

- **Arm:** flip the switch at the top of the Cues tab, or press **⌥⇧S** (Alt+Shift+S). The toolbar badge reads **CUE** while armed (**ON** still wins while a spotlight is on), and the tab shows an **Armed** label. Every browser session starts unarmed, so cues never fire when you aren't presenting.
- **Record:** on the page, click **Record cue**.
  1. Click the element that should trigger the cue. A pink outline shows what will be picked, and the click goes through to the page, so whatever it opens appears.
  2. The spotlight turns on as a box. Click to place it, then drag and resize it as usual. Zoom in with 🔍 if the cue should zoom. What you see is what's saved.
  3. Click **Save cue** or press Enter (Esc cancels).
- **When a cue fires,** the spotlight is placed exactly as if you had placed it by hand, with the cue's size, shape and zoom instead of the popup's. Everything else works as usual: drag, resize, ⌖ (back to the popup's size and shape), 🔍, ✕ and ⌥S. The effect and strength come from the Spotlight tab.
- **Edit:** the Cues tab lists this page's cues (**Show all** lists every cue). Click one to open its editor; changes save as you make them:
  - **Name** and **Page** (the URL pattern; see below).
  - **Trigger:** **Pick on page** to click a different element (the cue's name follows it if you never renamed the cue), **Check on page** to outline the element the cue finds now, and **Matching** to edit how it's found: each way is a CSS selector, optionally limited to elements with an exact name. They're tried in order and the first that finds exactly one element wins; Check shows how many elements each one finds. You can edit, remove and add them.
  - **Area:** for the width and the height, either **Follows element** (with padding on each side) or **Fixed** (a size, measured from the left/top, the right/bottom, or the centre). Switching between them keeps the spotlight where it is on the page. **Redraw on page** lets you place and size it again with the mouse.
  - **Shape:** box or circle (a circle's height is its width).
  - **Ends:** how the cue's spotlight turns off: manually (✕ or ⌥S, the default), on a click on an element you pick on the page (e.g. a drawer's Close button; the click still goes through to the page; it has the same Pick, Check and Matching controls as the trigger), on a click outside the spotlight, or after a delay. A click that ends one cue can trigger another.
  - **Options:** zoom in, scroll into view, and how long to wait for the element to appear.
  - **Delete:** the trash button on the cue's row, or **Delete cue** at the bottom of its editor.
  - **Test** shows the cue's spotlight on the page; while it's showing, every change you make updates it right away. Test, redraw, picking and checking elements need the cue's page, so they appear only for cues on this page.
- **Test at** resizes the window to 1280, 1440 or 1920 pixels wide (↺ restores it) so you can check how cues adapt.
- **Open cue manager** opens a full page with every cue, grouped by site, in the same editor, plus **Import** and **Export** (JSON) to share cues with others.

### How cues find things again

- **Pages:** a cue is saved with a URL pattern made from the page you recorded it on. Parts that look like ids or slugs become wildcards, so `/organizations/acme/issues/12345/` becomes `/organizations/:org/issues/:id/` and matches every issue in every org. `:name` matches one path segment and `*` matches anything. The query string and `#hash` are ignored, and a trailing slash is optional.
- **The trigger:** a cue remembers several ways to find the element: its test id (`data-test-id` and similar), a stable `id`, its role and visible name, and its position in the page. It keeps only the ways that picked out exactly that one element when recorded, and later uses the first one that still does. Generated class names and ids are never used. Hidden copies of an element (say, a desktop and a mobile version of a toolbar, one hidden) don't count as duplicates, and the position in the page is also tried from the top of the page, so an element can be found even when everything around it is duplicated. Pages that replace an element as you press it are handled too: what you pressed is what counts, even when the browser then sends no click.
- **The spotlight's area** is stored relative to an element, not as a position on screen, so it adapts to other window sizes. If the spotlight you drew fits an element (each edge within 24 px), the cue fits that element plus the same padding, wherever it is and however big it gets. Otherwise it's stored inside the smallest element that contains it, with each edge either following that element's edge or keeping a fixed size, depending on where you drew it. If no element can be found again, it's placed relative to the window.
- **Timing:** after the click, the cue waits up to 3 seconds for its element to appear and stop moving (a drawer sliding in, say), scrolls it into view if needed, then places the spotlight. If the element isn't there, is hidden at this window size, or is off-screen, it shows a message instead of spotlighting the wrong thing.
- **Clicks that load a new page** finish on the new page (same site, within 10 seconds).

Cue limitations: only clicks trigger (or end) cues; synthetic clicks made by page scripts are ignored; elements inside iframes or other sites' shadow DOM can't be triggers or anchors; and a layout that changes completely at some window size can leave a cue without its element.

## Popup options

- **Shape:** Circle or Box (a rounded rectangle). A circle has one **Size** slider; a box has **Width** and **Height**.
- **Effect:** what happens to the rest of the page.
  - **Dim** darkens it.
  - **Blur** blurs it.
  - **Both** applies a fixed blur and darkens it.
- **Strength:** how dark the dimming is for **Dim** and **Both**, or how strong the blur is for **Blur**.
- **Ink:** the colour of the disappearing ink: pink, blurple, yellow, lime or white, or any colour from the picker at the end.
- **Zoom:** two independent on/off toggles for automatic zoom.
  - **On place** (off by default): zoom in as soon as you click to place the spotlight and it stops following the cursor.
  - **After resize** (on by default): zoom in to the new size when you finish resizing with a handle. Resizing while zoomed always zooms out first (around the handle, so it stays under your cursor), so you see the page at normal size while you adjust it. With this off, it stays zoomed out.

All settings apply live and are remembered. If you saved a shape or effect that this version no longer offers, it switches to the nearest one: Ellipse becomes Circle, Rectangle becomes Box, and Black out or Grayscale become Dim.

## The outline

A dashed line around the spotlight, with a dark halo so it shows on light and dark pages. It's hidden while your cursor is outside the spotlight, faint while the cursor is inside it, and clearly visible near the edge (where you can grab it) or while you drag or resize. The two resize handles fade in and out the same way, and you can still grab them while they're hidden. The edge has a fixed 6 px soft feather.

## How it works

One click-through layer covers the viewport and applies the effect (`background` plus `backdrop-filter`). The hole is the chosen shape drawn as an SVG and used as a CSS mask layer. It is combined with a full-coverage layer using `mask-composite: exclude`, so both shapes and the soft edge work with every effect. Moving the spotlight only changes `mask-position`.

The outline is an SVG whose shape uses `pointer-events: stroke`. Only the edge band catches the mouse, which is why you can drag it by the edge while the page inside the spotlight stays clickable.

Everything lives in a closed shadow root on `<html>`, so the page's CSS can't affect it.

## Known limitations

- **Zoom and pinned elements:** zoom is a CSS transform on `<body>`. While zoomed, elements fixed to the viewport (sticky headers, chat widgets) scale and move with the page. Scrolling while zoomed moves the page at normal speed under the magnified view.

- The placed spotlight stays fixed on the screen. When you scroll, the page moves underneath it.
- **iframes:** the script runs only in the top frame. While the cursor is over embedded content from another site (a video, a Stripe form, and so on), the following spotlight pauses at the iframe's edge.
- Fullscreen elements, such as a fullscreen video, cover the spotlight.
- Chrome doesn't allow extensions on `chrome://` pages, the Chrome Web Store, or the built-in PDF viewer.
