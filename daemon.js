const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const dotenv = require('dotenv');
const os = require('os');
const { parseSite } = require('./helpers/parse');
const { processWithOllama } = require('./helpers/ollama');
const { logResult, logDaemon } = require('./helpers/log');
const { CronExpressionParser } = require('cron-parser');

process.on('unhandledRejection', async (reason, promise) => {
  const message = `Unhandled Rejection at: ${promise}, reason: ${reason.stack || reason}`;
  console.error(message);
  await logDaemon(message);
  await logResult(message);
});

process.on('uncaughtException', async (err, origin) => {
  const message = `Uncaught Exception: ${err.message}, origin: ${origin}`;
  console.error(message);
  await logDaemon(message);
  await logResult(message);
});

const USERSCRIPTS_DIR = path.join(os.homedir(), '.web-observer', 'userscripts');
const scheduledTasks = [];
let keepAliveTimer;

async function ensureUserscriptsDir() {
  try {
    await fs.mkdir(USERSCRIPTS_DIR, { recursive: true });
  } catch (err) {
    console.error('Error creating userscripts directory:', err.message);
    await logDaemon(`Error creating userscripts directory: ${err.message}`);
    process.exit(1);
  }
}

async function parseDuration(duration) {
  try {
    if (!duration) return null;
    const trimmedDuration = duration.trim();
    if (trimmedDuration.split(' ').length === 5 && cron.validate(trimmedDuration)) {
      await logDaemon(`Valid cron schedule: ${trimmedDuration}`);
      return { type: 'cron', schedule: trimmedDuration };
    }
    if (trimmedDuration.includes('.')) {
      if (trimmedDuration.includes(' ')) {
        const [date, time] = trimmedDuration.split(' ');
        const [day, month, year] = date.split('.').map(Number);
        const [hour, minute] = time.split('.').map(Number);
        const target = new Date(2000 + year, month - 1, day, hour, minute);
        if (isNaN(target)) throw new Error('Invalid date format');
        return { type: 'once', delay: target - new Date() };
      } else {
        const [hour, minute] = trimmedDuration.split('.').map(Number);
        if (isNaN(hour) || isNaN(minute)) throw new Error('Invalid time format');
        return { type: 'cron', schedule: `${minute} ${hour} * * *` };
      }
    }
    throw new Error('Invalid duration format');
  } catch (err) {
    console.error(`Error parsing duration "${duration}":`, err.message);
    await logDaemon(`Error parsing duration "${duration}": ${err.message}`);
    return null;
  }
}

async function loadConfig(filePath) {
  try {
    const config = dotenv.parse(await fs.readFile(filePath));
    const required = ['url', 'model', 'prompt', 'tags'];
    for (const field of required) {
      if (!config[field]) throw new Error(`Missing required field: ${field}`);
    }
    if (!config.prompt.includes('{content}')) throw new Error('Prompt must include {content}');
    if (!/https?:\/\/.+/.test(config.url)) throw new Error('Invalid URL format');
    if (config.tags.trim() === '') throw new Error('Tags cannot be empty');
    if (config.ollama_host && !/https?:\/\/.+/.test(config.ollama_host)) throw new Error('Invalid ollama_host URL');
    return config;
  } catch (err) {
    console.error(`Error loading config ${filePath}:`, err.message);
    await logDaemon(`Error loading config ${filePath}: ${err.message}`);
    throw err;
  }
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
        await logDaemon(`Error loading config ${file}: ${err.message}`);
      }
    }
  }
  await logDaemon(`Loaded ${tasks.length} valid tasks`);
  return tasks;
}

async function runTask(task, logToConsole = false) {
  const taskName = task.config.name || task.file;
  try {
    await logDaemon(`Starting task ${taskName}`);
    const { url, tags, model, prompt, ollama_host } = task.config;
    const content = await parseSite(url, tags.split(',').map(t => t.trim()));
    if (content === 'Error parsing site') {
      const message = `Error running task ${taskName}: Failed to parse site`;
      console.error(message);
      await logResult(message);
      await logDaemon(message);
      return;
    }
    const result = await processWithOllama(model, prompt, content, ollama_host || 'http://localhost:11434');
    if (result === 'Error processing with Ollama') {
      const message = `Error running task ${taskName}: Failed to process with Ollama`;
      console.error(message);
      await logResult(message);
      await logDaemon(message);
      return;
    }
    const message = `Result for ${taskName}:\n${result}`;
    await logResult(message);
    if (logToConsole) console.log(message);
    await logDaemon(`Task ${taskName} completed successfully`);
  } catch (err) {
    const message = `Error running task ${taskName}: ${err.message}`;
    console.error(message);
    await logResult(message);
    await logDaemon(message);
  }
}

function getNextCronExecution(schedule) {
  try {
    const interval = CronExpressionParser.parse(schedule, { tz: 'Europe/Moscow' });
    const next = interval.next().toDate();
    const timeToNext = next.getTime() - Date.now();
    return timeToNext;
  } catch (err) {
    console.error(`Error parsing cron schedule ${schedule}:`, err.message);
    await logDaemon(`Error parsing cron schedule ${schedule}: ${err.message}`);
    return Infinity;
  }
}

async function startDaemon() {
  try {
    await logDaemon('Daemon initialization started');
    const tasks = await loadConfigs();
    await logDaemon(`Starting daemon with ${tasks.length} tasks`);
    for (const task of tasks) {
      const duration = await parseDuration(task.config.duration);
      if (!duration) {
        console.error(`No duration specified for task ${task.config.name || task.file}`);
        await logDaemon(`No duration specified for task ${task.config.name || task.file}`);
        continue;
      }
      if (duration.type === 'once') {
        if (duration.delay > 0) {
          const timeout = setTimeout(async () => {
            try {
              await runTask(task);
              await logDaemon(`One-time task ${task.config.name || task.file} completed`);
            } catch (err) {
              console.error(`Error in one-time task ${task.config.name || task.file}: ${err.message}`);
              await logDaemon(`Error in one-time task ${task.config.name || task.file}: ${err.message}`);
            }
          }, duration.delay);
          scheduledTasks.push({ task, timeout });
          await logDaemon(`Scheduled one-time task ${task.config.name || task.file} in ${duration.delay}ms`);
        }
      } else if (duration.type === 'cron') {
        if (cron.validate(duration.schedule)) {
          const cronTask = cron.schedule(duration.schedule, async () => {
            try {
              await runTask(task);
              await logDaemon(`Cron task ${task.config.name || task.file} completed`);
            } catch (err) {
              console.error(`Error in cron task ${task.config.name || task.file}: ${err.message}`);
              await logDaemon(`Error in cron task ${task.config.name || task.file}: ${err.message}`);
            }
          }, {
            scheduled: true,
            timezone: 'Europe/Moscow'
          });
          scheduledTasks.push({ task, cronTask });
          await logDaemon(`Scheduled cron task ${task.config.name || task.file} with schedule ${duration.schedule}`);
        } else {
          console.error(`Invalid cron schedule for task ${task.config.name || task.file}: ${duration.schedule}`);
          await logDaemon(`Invalid cron schedule for task ${task.config.name || task.file}: ${duration.schedule}`);
        }
      }
    }
    await logDaemon(`All tasks processed, ${scheduledTasks.length} scheduled`);
    process.stdin.resume();
    keepAliveTimer = setInterval(async () => {
      try {
        let minTime = Infinity;
        let nextTask = null;
        for (const { task, cronTask } of scheduledTasks) {
          if (cronTask) {
            const timeToNext = getNextCronExecution(task.config.duration);
            if (timeToNext < minTime) {
              minTime = timeToNext;
              nextTask = task.config.name || task.file;
            }
          }
        }
      } catch (err) {
        console.error(`Error in keepAliveTimer: ${err.message}`);
        await logDaemon(`Error in keepAliveTimer: ${err.message}`);
      }
    }, 5000);
    await logDaemon('Daemon initialization completed');
  } catch (err) {
    console.error(`Daemon crashed: ${err.message}`);
    await logResult(`Daemon crashed: ${err.message}`);
    await logDaemon(`Daemon crashed: ${err.message}`);
    process.exit(1);
  }
}

async function stopDaemon() {
  try {
    scheduledTasks.forEach(t => t.timeout ? clearTimeout(t.timeout) : t.cronTask.destroy());
    scheduledTasks.length = 0;
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    await logDaemon('Daemon stopped');
  } catch (err) {
    console.error(`Error stopping daemon: ${err.message}`);
    await logDaemon(`Error stopping daemon: ${err.message}`);
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