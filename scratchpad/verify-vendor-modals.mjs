import { chromium } from 'playwright';
import path from 'node:path';

const BASE = 'http://127.0.0.1:4173';

async function run() {
  const browser = await chromium.launch();

  // 1) Unauthenticated redirect check
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}/vendor.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    console.log('Unauth redirected to:', page.url());
    console.log('Unauth console errors:', errors);
    await page.screenshot({ path: path.resolve('scratchpad', 'vendor-unauth.png') });
    await page.close();
  }

  await browser.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
