const fs = require('fs');
const http = require('http');
const path = require('path');
const https = require('https');

const root = path.resolve(__dirname, '..');
const sourcesPath = path.join(root, 'benchmark', 'sample-sources.json');
const outputDir = path.join(root, 'benchmark', 'samples');
const manifestPath = path.join(outputDir, 'manifest.json');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchToBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'http:' ? http : https;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://commons.wikimedia.org/',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirects > 8) {
          reject(new Error(`Too many redirects for ${url}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        res.resume();
        resolve(fetchToBuffer(nextUrl, redirects + 1));
        return;
      }
      if (status === 429) {
        reject(Object.assign(new Error(`Rate limited for ${url}`), { code: 429 }));
        res.resume();
        return;
      }
      if (status < 200 || status >= 300) {
        reject(new Error(`Request failed for ${url}: ${status}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

async function fetchWithRetry(url, attempt = 0) {
  try {
    return await fetchToBuffer(url);
  } catch (error) {
    if (error && error.code === 429 && attempt < 4) {
      await sleep(1200 * (attempt + 1));
      return fetchWithRetry(url, attempt + 1);
    }
    throw error;
  }
}

async function main() {
  ensureDir(outputDir);
  const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
  const manifest = [];

  for (const source of sources) {
    try {
      const filePath = path.join(outputDir, source.localFile);
      const buffer = await fetchWithRetry(source.downloadUrl);
      fs.writeFileSync(filePath, buffer);
      manifest.push({
        id: source.id,
        title: source.title,
        file: `./samples/${source.localFile}`,
        sourcePage: source.sourcePage,
        license: source.license,
      });
      process.stdout.write(`Downloaded ${source.title}\n`);
      await sleep(400);
    } catch (error) {
      process.stderr.write(`Skipped ${source.title}: ${error.message}\n`);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  process.stdout.write(`Wrote manifest: ${manifestPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
