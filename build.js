import esbuild from 'esbuild';
import { createServer } from 'http';
import { readFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { extname, join } from 'path';

// Copy the PDF.js worker into dist/ so it lives alongside the bundle.
// loader.js resolves it as new URL('./pdf.worker.mjs', import.meta.url).
function copyWorker() {
  mkdirSync('dist', { recursive: true });
  const workerSrc = join('node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs');
  copyFileSync(workerSrc, join('dist', 'pdf.worker.mjs'));
}

const isDev = process.argv.includes('--dev');

const sharedConfig = {
  entryPoints: ['src/PageFlipOpen.js'],
  bundle: true,
  target: ['chrome90', 'firefox90', 'safari15'],
  sourcemap: isDev,
  logLevel: 'info',
};

async function build() {
  copyWorker();

  // ES module output
  await esbuild.build({
    ...sharedConfig,
    format: 'esm',
    outfile: 'dist/pageflipopen.js',
  });

  // IIFE output — exposes PageFlipOpen class directly on window
  await esbuild.build({
    ...sharedConfig,
    format: 'iife',
    globalName: '__PFOBundle',
    footer: { js: 'window.PageFlipOpen = __PFOBundle.PageFlipOpen;' },
    outfile: 'dist/pageflipopen.iife.js',
  });

  // Minified IIFE
  await esbuild.build({
    ...sharedConfig,
    format: 'iife',
    globalName: '__PFOBundle',
    footer: { js: 'window.PageFlipOpen=__PFOBundle.PageFlipOpen;' },
    minify: true,
    outfile: 'dist/pageflipopen.min.js',
    sourcemap: false,
  });

  console.log('Build complete.');
}

async function dev() {
  copyWorker();

  const ctx = await esbuild.context({
    ...sharedConfig,
    format: 'esm',
    outfile: 'dist/pageflipopen.js',
  });

  await ctx.watch();
  console.log('Watching for changes...');

  // Simple static dev server
  const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.pdf':  'application/pdf',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
  };

  const server = createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/test/index.html';

    // Map roots
    let filePath;
    if (urlPath.startsWith('/dist/')) {
      filePath = join(process.cwd(), urlPath);
    } else if (urlPath.startsWith('/test/')) {
      filePath = join(process.cwd(), urlPath);
    } else if (urlPath.startsWith('/assets/')) {
      filePath = join(process.cwd(), urlPath);
    } else if (urlPath === '/pageflipopen.css') {
      filePath = join(process.cwd(), 'pageflipopen.css');
    } else if (urlPath.startsWith('/node_modules/')) {
      filePath = join(process.cwd(), urlPath);
    } else {
      filePath = join(process.cwd(), urlPath);
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found: ' + urlPath);
      return;
    }

    const ext = extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(readFileSync(filePath));
  });

  server.listen(3000, () => {
    console.log('Dev server running at http://localhost:3000');
  });
}

if (isDev) {
  dev();
} else {
  build();
}
