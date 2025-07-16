const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const dotenv = require('dotenv');
const os = require('os');
const { parseSite } = require('./helpers/parse');
const { processWithOllama } = require('./helpers/ollama');
const { logResult, logDaemon } = require('./helpers/log');

process.on('unhandledRejection', async (reason, promise) => {
  const message = `Unhandled Rejection at: ${promise}, reason: ${reason.stack || reason}`;
  console.error(message);
  await logDaemon(message);
});

process.on('uncaughtException', async (err, origin) => {
  const message = `Uncaught Exception: ${err.message}, origin: ${origin}`;
  console.error(message);
  await logDaemon(message);
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
    await stopDaemon();
    process.exit(1);
  }
}

async function parseDuration(duration) {
  try {
    if (!duration) return null;
    const trimmedDuration = duration.trim();
    if (trimmedDuration.split(' ').length === 5 && cron.validate(trimmedDuration)) {
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

        if (config.tags) {
          config.tags = config.tags
            .split(',')
            .map(t => t.trim())
            .map(t => t.replace(/^["']+|["']+$/g, ''))
            .map(t => t.replace(/[\r\n\t]/g, ''))
            .filter(t => t.length > 0)
            .join(',');
        }

        tasks.push({ file, config });
      } catch (err) {
        console.error(`Error loading config ${file}:`, err.message);
        await logDaemon(`Error loading config ${file}: ${err.message}`);
      }
    }
  }
  return tasks;
}

async function runTask(task, logToConsole = false) {
  const taskName = task.config.name || task.file;
  try {
    const { url, tags, model, prompt, ollama_host } = task.config;

    let content;
    try {
      const cleanedTags = tags.split(',').map(t => t.trim()).map(t => t.replace(/^["']|["']$/g, ''));
      content = await parseSite(url, cleanedTags);
      if (content === 'Error parsing site') throw new Error('Failed to parse site');
    } catch (err) {
      await logDaemon(`Parsing error in task ${taskName}: ${err.message}`);
      return;
    }

    let result;
    try {
      result = await processWithOllama(model, prompt, content, ollama_host || 'http://localhost:11434');
      if (result === 'Error processing with Ollama') throw new Error('Failed to process with Ollama');
    } catch (err) {
      await logDaemon(`Ollama processing error in task ${taskName}: ${err.message}`);
      return;
    }

    const message = `Result for «${taskName}» (${model}):\n${result}\n======`;
    await logResult(message);
    if (logToConsole) console.log(message);
  } catch (err) {
    await logDaemon(`Unexpected error in task ${taskName}: ${err.message}`);
  }
}

async function startDaemon() {
  try {
    const tasks = await loadConfigs();
    for (const task of tasks) {
      const duration = await parseDuration(task.config.duration);
      if (!duration) {
        await logDaemon(`No duration specified for task ${task.config.name || task.file}`);
        continue;
      }

      if (duration.type === 'once') {
        if (duration.delay > 0) {
          const timeout = setTimeout(async () => {
            try {
              await runTask(task);
            } catch (err) {
              await logDaemon(`Error in one-time task ${task.config.name || task.file}: ${err.message}`);
            }
          }, duration.delay);
          scheduledTasks.push({ task, timeout });
        }
      } else if (duration.type === 'cron') {
        if (!cron.validate(duration.schedule)) {
          await logDaemon(`Invalid cron schedule for task ${task.config.name || task.file}: ${duration.schedule}`);
          continue;
        }

        try {
          const cronTask = cron.schedule(duration.schedule, () => {
            (async () => {
              try {
                await runTask(task);
              } catch (err) {
                await logDaemon(`Error in cron task ${task.config.name || task.file}: ${err.message}`);
              }
            })();
          }, {
            scheduled: true,
            timezone: 'Europe/Moscow',
          });

          scheduledTasks.push({ task, cronTask });
        } catch (err) {
          await logDaemon(`Failed to schedule cron task ${task.config.name || task.file}: ${err.message}`);
        }
      }
    }

    keepAliveTimer = setInterval(() => {}, 10000);
    process.stdin.resume();
  } catch (err) {
    await logDaemon(`Fatal error in startDaemon: ${err.message}`);
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
  } catch (err) {
    console.error(`Error stopping daemon: ${err.message}`);
    await logDaemon(`Error stopping daemon: ${err.message}`);
  }
}

module.exports = { loadConfig, runTask, startDaemon, stopDaemon };

if (process.argv.includes('--daemon')) {
  (async () => {
    try {
      await startDaemon();
    } catch (err) {
      console.error('Fatal error in startDaemon:', err.message);
      await logDaemon('Fatal error in startDaemon: ' + err.message);
      process.exit(1);
    }
  })();
}

process.on('exit', (code) => {
  if (process.argv.includes('--daemon')) {
    logDaemon(`Process exit event with code: ${code}`);
  }
});

process.on('SIGINT', async () => {
  await logDaemon('SIGINT received');
  await stopDaemon();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await logDaemon('SIGTERM received');
  await stopDaemon();
  process.exit(0);
});
