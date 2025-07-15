const puppeteer = require('puppeteer');

async function parseSite(url, tags) {
  let browser;
  try {
    if (!url || !/https?:\/\/.+/.test(url)) throw new Error('Invalid URL');
    if (!tags || !Array.isArray(tags) || tags.length === 0) throw new Error('Tags must be a non-empty array');

    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });

    const include = tags.filter(t => !t.startsWith('!')).map(t => t.trim()).filter(t => t);
    const exclude = tags.filter(t => t.startsWith('!')).map(t => t.slice(1).trim()).filter(t => t);

    for (const selector of [...include, ...exclude]) {
      try {
        await page.evaluate(sel => document.querySelector(sel), selector);
      } catch (err) {
        throw new Error(`Invalid CSS selector: ${selector}`);
      }
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

    return content || 'No content found';
  } catch (err) {
    console.error(`Error parsing ${url}:`, err.message);
    return 'Error parsing site';
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { parseSite };