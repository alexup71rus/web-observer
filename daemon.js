const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const dotenv = require('dotenv');
const { parseSite } = require('./helpers/parse');
const { processWithOllama } = require('./helpers/ollama');
const { logResult } = require('./helpers/log');

const USERSCRIPTS_DIR = path.join(process.cwd(), 'userscripts');
const scheduledTasks = [];
let keepAliveTimer;

async function ensureUserscriptsDir() {
  try {
    await fs.mkdir(USERSCRIPTS_DIR, { recursive: true });
  } catch (err) {
    console.error('Error creating userscripts directory:', err);
    process.exit(1);
  }
}

function parseDuration(duration) {
  try {
    if (!duration) return null;

    if (duration.split(' ').length === 5 && cron.validate(duration)) {
      return { type: 'cron', schedule: duration };
    }

    if (duration.includes('.')) {
      if (duration.includes(' ')) {
        const [date, time] = duration.split(' ');
        const [day, month, year] = date.split('.').map(Number);
        const [hour, minute] = time.split('.').map(Number);
        const target = new Date(2000 + year, month - 1, day, hour, minute);
        if (isNaN(target)) throw new Error('Invalid date format');
        return { type: 'once', delay: target - new Date() };
      } else {
        const [hour, minute] = duration.split('.').map(Number);
        if (isNaN(hour) || isNaN(minute)) throw new Error('Invalid time format');
        return { type: 'cron', schedule: `${minute} ${hour} * * *` };
      }
    }
    throw new Error('Invalid duration format');
  } catch (err) {
    console.error(`Error parsing duration "${duration}":`, err.message);
    return null;
  }
}

async function loadConfig(filePath) {
  const config = dotenv.parse(await fs.readFile(filePath));
  const required = ['url', 'model', 'prompt', 'tags'];
  for (const field of required) {
    if (!config[field]) throw new Error(`Missing required field: ${field}`);
  }
  if (!config.prompt.includes('{content}')) throw new Error('Prompt must include {content}');
  if (!/https?:\/\/.+/.test(config.url)) throw new Error('Invalid URL format');
  if (config.tags.trim() === '') throw new Error('Tags cannot be empty');
  if (config.ollama_host && !/https?:\/\/.+/.test(config.ollama_host)) throw new Error('Invalid ollama_host format');
  return config;
}

async function loadConfigs() {
  const tasks = [];
  await ensureUserscriptsDir();
  const files = await fs.readdir(USERSCRIPTS_DIR);
  for (const file of files) {
    if (file.endsWith('.env')) {
      try {
        const config = await loadConfig(path.join(USERSCRIPTS_DIR, file));
        tasks.push({ file, config });
      } catch (err) {
        console.error(`Error loading config ${file}:`, err.message);
      }
    }
  }
  return tasks;
}

async function runTask(task, logToConsole = false) {
  try {
    const { url, tags, model, prompt, ollama_host } = task.config;
    const content = await parseSite(url, tags.split(',').map(t => t.trim()));
    const result = await processWithOllama(model, prompt, content, ollama_host || 'http://localhost:11434');
    const message = `Result for ${task.config.name || task.file}:\n${result}`;
    await logResult(message);
    if (logToConsole) console.log(message);
  } catch (err) {
    const message = `Error running task ${task.config.name || task.file}: ${err.message}`;
    console.error(message);
    await logResult(message);
    if (logToConsole) console.log(message);
  }
}

async function startDaemon() {
  console.log('Daemon started, tasks scheduled');
  const tasks = await loadConfigs();
  tasks.forEach(task => {
    const duration = parseDuration(task.config.duration);
    if (!duration) {
      console.log(`Task ${task.config.name || task.file} not scheduled: no duration specified`);
      return;
    }
    if (duration.type === 'once') {
      if (duration.delay > 0) {
        const timeout = setTimeout(() => runTask(task), duration.delay);
        scheduledTasks.push({ task, timeout });
      } else {
        console.log(`Task ${task.config.name || task.file} skipped: past date`);
      }
    } else if (duration.type === 'cron') {
      if (cron.validate(duration.schedule)) {
        const cronTask = cron.schedule(duration.schedule, () => runTask(task));
        scheduledTasks.push({ task, cronTask });
      } else {
        console.log(`Task ${task.config.name || task.file} not scheduled: invalid cron schedule`);
      }
    }
  });

  if (scheduledTasks.length === 0) {
    keepAliveTimer = setInterval(() => {}, 1000 * 60 * 60);
  }
}

async function stopDaemon() {
  scheduledTasks.forEach(t => t.timeout ? clearTimeout(t.timeout) : t.cronTask.destroy());
  scheduledTasks.length = 0;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

module.exports = { loadConfig, runTask, startDaemon, stopDaemon };

if (process.argv.includes('--daemon')) {
  startDaemon();
}

process.on('SIGTERM', async () => {
  await stopDaemon();
  process.exit(0);
});