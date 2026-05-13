import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:4173/benchmark/');
await page.waitForLoadState('networkidle');

const samples = [
  '0601 Acne Vulgaris',
  'Acne vulgaris on a very oily skin',
  'Girl Suffering From Pimples',
  'Teenager with acne',
];

console.log('\n=== BENCHMARK VISUAL TEST ===\n');

for (const sample of samples) {
  await page.getByLabel('Sample').selectOption([sample]);
  await page.getByLabel('Strength').fill('80');
  await page.getByLabel('Strength').dispatchEvent('input');
  await page.getByLabel('View').selectOption(['Processed']);
  await page.getByRole('button', { name: 'Run benchmark' }).click();
  await page.getByText('Benchmark complete').first().waitFor({ state: 'visible', timeout: 30000 });

  const metricsC = await page.locator('#candidate-c-metrics').textContent();
  console.log(`[${sample}] Candidate C: ${metricsC.replace(/\s+/g, ' ').trim()}`);
}

// Take processed screenshot
await page.getByLabel('Sample').selectOption(['0601 Acne Vulgaris']);
await page.getByRole('button', { name: 'Run benchmark' }).click();
await page.getByText('Benchmark complete').first().waitFor({ state: 'visible', timeout: 30000 });
await page.screenshot({ path: 'benchmark/test-result-processed.png', fullPage: true });

// Take mask screenshot
await page.getByLabel('View').selectOption(['Mask']);
await page.getByRole('button', { name: 'Run benchmark' }).click();
await page.getByText('Benchmark complete').first().waitFor({ state: 'visible', timeout: 30000 });
await page.screenshot({ path: 'benchmark/test-result-mask.png', fullPage: true });

console.log('\nScreenshots saved: benchmark/test-result-processed.png, benchmark/test-result-mask.png');

await browser.close();
