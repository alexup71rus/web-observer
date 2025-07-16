const puppeteer = require('puppeteer');
const { logDaemon } = require('./log');

function validateSelector(sel) {
  try {
    return document.querySelector(sel) !== null;
  } catch (e) {
    return `Invalid selector error inside page context: ${e.message}`;
  }
}

function extractContent(include, exclude) {
  const results = [];
  for (const inc of include) {
    let elements;
    try {
      elements = document.querySelectorAll(inc);
    } catch (e) {
      return `Error: Invalid selector in content extraction: ${inc}`;
    }
    for (const el of elements) {
      if (!exclude.length || !exclude.some(ex => el.matches(ex))) {
        results.push(el.textContent.trim());
      }
    }
  }
  return results.join('\n') || '';
}

async function parseSite(url, tags, retries = 2, retryDelay = 2000) {
  let browser = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (!url || !/https?:\/\/.+/.test(url)) throw new Error('Invalid URL');
      if (!tags || !Array.isArray(tags) || tags.length === 0) throw new Error('Tags must be a non-empty array');

      browser = await puppeteer.launch({ headless: 'new', timeout: 30000 });
      const page = await browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      );

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      const include = tags.filter(t => !t.startsWith('!')).map(t => t.trim()).filter(Boolean);
      const exclude = tags.filter(t => t.startsWith('!')).map(t => t.slice(1).trim()).filter(Boolean);

      for (const selector of [...include, ...exclude]) {
        const result = await page.evaluate(validateSelector, String(selector));
        if (typeof result === 'string' && result.startsWith('Invalid selector error')) {
          throw new Error(result);
        }
      }

      const content = await page.evaluate(extractContent, include, exclude);
      if (typeof content === 'string' && content.startsWith('Error:')) {
        throw new Error(content);
      }

      await browser.close();
      browser = null;

      return content || 'No content found';
    } catch (err) {
      await logDaemon(`Error parsing ${url} (attempt ${attempt}/${retries}): ${err.message}`);
      if (browser) {
        try {
          await browser.close();
        } catch {}
        browser = null;
      }
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        return 'Error parsing site';
      }
    }
  }
  return 'Error parsing site';
}

module.exports = { parseSite };
