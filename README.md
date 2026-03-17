# PageFlipOpen

A JavaScript library that renders a PDF as an interactive 3D flipbook in the browser.

## Features

- 3D page-turn animation
- PDF rendering via PDF.js
- Double-page spread layout
- Pinch-to-zoom and pan (touch and mouse)
- Keyboard navigation
- Fullscreen support
- Toolbar

## Installation

Download the latest release and copy the `dist/` folder and `pageflipopen.css` into your project.

## Quick Start

```html
<link rel="stylesheet" href="pageflipopen.css" />
<script src="dist/pageflipopen.min.js"></script>

<div id="flipbook" style="width: 100%; height: 600px;"></div>

<script>
  PageFlipOpen.setPdfWorkerSrc('/dist/pdf.worker.mjs');

  new PageFlipOpen(document.getElementById('flipbook'), {
    source: '/path/to/document.pdf',
  });
</script>
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `source` | `string` | `null` | URL of the PDF to load. Required. |
| `startPage` | `number` | `1` | Page to open on. |
| `flipDuration` | `number` | `800` | Page-turn animation duration in ms. |
| `autoLayout` | `boolean` | `true` | Detect single vs double page based on container width. |
| `singlePageMode` | `boolean` | `false` | Force single-page layout. |
| `zoom` | `number` | `1` | Initial zoom level. |
| `zoomMin` | `number` | `1` | Minimum zoom level. |
| `zoomMax` | `number` | `3` | Maximum zoom level. |
| `backgroundColor` | `string` | `'transparent'` | Container background colour. |
| `pageBackground` | `string` | `'#fff'` | Page background colour. |
| `enableFullscreen` | `boolean` | `true` | Show fullscreen button. |
| `enableDownload` | `boolean` | `false` | Show download button. |
| `downloadFilename` | `string` | `null` | Filename for download. Defaults to the PDF filename from the URL. |
| `enableKeyboard` | `boolean` | `true` | Enable arrow key navigation. |
| `enableTouch` | `boolean` | `true` | Enable touch gestures. |
| `toolbar` | `boolean` | `true` | Show the toolbar. |
| `toolbarAlwaysVisible` | `boolean` | `false` | Keep toolbar visible instead of fading. |
| `onReady` | `function` | `null` | Called when the PDF is loaded and ready. |
| `onPageChange` | `function` | `null` | Called with the current page number on each page turn. |
| `onError` | `function` | `null` | Called with an `Error` when loading fails. |

## API

```js
const flipbook = new PageFlipOpen(container, options);

flipbook.flipTo(pageNumber)   // Jump to a page
flipbook.next()               // Next spread
flipbook.prev()               // Previous spread
flipbook.first()              // First page
flipbook.last()               // Last page
flipbook.zoomIn()
flipbook.zoomOut()
flipbook.zoomReset()
flipbook.toggleFullscreen()
flipbook.destroy()            // Clean up and remove from DOM

flipbook.currentPage          // Current left page number
flipbook.totalPages           // Total page count
flipbook.layout               // 'single' | 'double'
flipbook.isAnimating          // true while a flip is in progress
```

## Building

```bash
npm install
npm run build   # production build → dist/
npm run dev     # watch mode + dev server at http://localhost:3000
```

## License

MIT
