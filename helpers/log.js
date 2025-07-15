const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const APP_DIR = path.join(os.homedir(), '.web-observer');
const LOG_FILE = path.join(APP_DIR, 'wo.log');
const RESULT_LOG_FILE = path.join(APP_DIR, 'wo-result.log');

async function ensureAppDir() {
  try {
    await fs.mkdir(APP_DIR, { recursive: true });
  } catch (err) {
    console.error(`Error creating app directory: ${err.message}`);
    process.exit(1);
  }
}

async function logError(message) {
  try {
    await ensureAppDir();
    await fs.appendFile(LOG_FILE, `${new Date().toISOString()} - ${message}\n`);
  } catch (err) {
    console.error(`Error writing to log file ${LOG_FILE}: ${err.message}`);
  }
}

async function logResult(message) {
  try {
    await ensureAppDir();
    await fs.appendFile(RESULT_LOG_FILE, `${new Date().toISOString()} - ${message}\n`);
  } catch (err) {
    console.error(`Error writing to result log file ${RESULT_LOG_FILE}: ${err.message}`);
  }
}

module.exports = { logError, logResult };