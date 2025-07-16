const puppeteer = require('puppeteer');
const { logDaemon } = require('./log');

async function parseSite(url, tags, retries = 3, retryDelay = 2000) {
  let browser = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (!url || !/https?:\/\/.+/.test(url)) throw new Error('Invalid URL');
      if (!tags || !Array.isArray(tags) || tags.length === 0) throw new Error('Tags must be a non-empty array');

      await logDaemon(`Starting site parsing for ${url} (attempt ${attempt}/${retries})`);
      browser = await puppeteer.launch({ headless: 'new', timeout: 30000 });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      const include = tags.filter(t => !t.startsWith('!')).map(t => t.trim()).filter(t => t);
      const exclude = tags.filter(t => t.startsWith('!')).map(t => t.slice(1).trim()).filter(t => t);

      for (const selector of [...include, ...exclude]) {
        await page.evaluate(sel => document.querySelector(sel), selector).catch(() => {
          throw new Error(`Invalid CSS selector: ${selector}`);
        });
      }

      const content = await page.evaluate((include, exclude) => {
        const results = [];
        for (const inc of include) {
          const elements = document.querySelectorAll(inc);
          for (const el of elements) {
            if (!exclude.length || !exclude.some(ex => el.matches(ex))) {
              results.push(el.textContent.trim());
            }
          }
        }
        return results.join('\n') || '';
      }, include, exclude);

      await logDaemon(`Site ${url} parsed successfully`);
      await browser.close();
      browser = null;
      return content || 'No content found';
    } catch (err) {
      await logDaemon(`Error parsing ${url} (attempt ${attempt}/${retries}): ${err.message}`);
      if (browser) {
        try {
          await browser.close();
          await logDaemon(`Browser closed for ${url} after error`);
        } catch (e) {
          await logDaemon(`Error closing browser: ${e.message}`);
        }
        browser = null;
      }
      if (attempt < retries) {
        await logDaemon(`Retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        await logDaemon(`Failed to parse ${url} after ${retries} attempts`);
        return 'Error parsing site';
      }
    }
  }
  await logDaemon(`Exhausted retries for ${url}, returning error`);
  return 'Error parsing site';
}

module.exports = { parseSite };