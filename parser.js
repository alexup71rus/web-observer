#!/usr/bin/env node

const { program } = require('commander');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
const { exec, spawn } = require('child_process');
const { execSync } = require('child_process');
const dotenv = require('dotenv');
const os = require('os');
const { CONFIG_TEMPLATE } = require('./template');
const { loadConfig, runTask } = require('./daemon');

const APP_DIR = path.join(os.homedir(), '.web-observer');
const USERSCRIPTS_DIR = path.join(APP_DIR, 'userscripts');
const isWindows = os.platform() === 'win32';
const isMacOS = os.platform() === 'darwin';
const BIN_DIR = isWindows ? 'C:\\Program Files\\web-observer' : path.join(os.homedir(), '.local/bin');
const BIN_NAME = isWindows ? 'wo.bat' : 'wo';
const DAEMON_BIN_NAME = isWindows ? 'wo-daemon.exe' : 'wo-daemon';
const BIN_SRC = path.join(path.dirname(process.execPath), isWindows ? 'wo.exe' : 'wo');
const DAEMON_BIN_SRC = path.join(path.dirname(process.execPath), isWindows ? 'wo-daemon.exe' : 'wo-daemon');
const LOG_FILE = path.join(APP_DIR, 'wo.log');
const PID_FILE = path.join(APP_DIR, 'daemon.pid');
const isSystemDir = process.execPath.includes(BIN_DIR);

async function ensureAppDir() {
  try {
    await fsp.mkdir(APP_DIR, { recursive: true });
  } catch (err) {
    const msg = `Error creating app directory: ${err.message}`;
    await logError(msg);
    console.error(msg);
    process.exit(1);
  }
}

async function logError(message) {
  try {
    await fsp.appendFile(LOG_FILE, `${new Date().toISOString()} - ${message}\n`);
  } catch (err) {
    console.error('Error writing to log file:', err.message);
  }
}

async function ensureUserscriptsDir() {
  try {
    await fsp.mkdir(USERSCRIPTS_DIR, { recursive: true });
  } catch (err) {
    const msg = `Error creating userscripts directory: ${err.message}`;
    await logError(msg);
    console.error(msg);
    process.exit(1);
  }
}

function sanitizeFilename(name) {
  if (!name || !name.trim()) throw new Error('Config name cannot be empty');
  return name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '').replace(/-+/g, '-').toLowerCase();
}

async function runCommand(cmd, errorMsg) {
  try {
    const npmCmd = isWindows ? 'npm.cmd' : 'npm';
    const finalCmd = cmd.replace(/^npm/, npmCmd);
    console.log(`Running: ${finalCmd}`);
    execSync(finalCmd, { stdio: 'inherit' });
  } catch (err) {
    const msg = `${errorMsg}: ${err.message || 'Unknown error'}`;
    await logError(msg);
    console.error(msg);
    process.exit(1);
  }
}

async function isDaemonRunning() {
  try {
    const pid = await fsp.readFile(PID_FILE, 'utf8');
    if (isWindows) {
      const { stdout } = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV`);
      if (!stdout.includes('wo-daemon.exe')) return false;
    }
    process.kill(parseInt(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function checkInstallation() {
  const nodeModulesExists = await fsp.access(path.join(__dirname, 'node_modules')).then(() => true).catch(() => false);
  const binExists = await fsp.access(path.join(BIN_DIR, BIN_NAME)).then(() => true).catch(() => false);
  const daemonBinExists = await fsp.access(path.join(BIN_DIR, DAEMON_BIN_NAME)).then(() => true).catch(() => false);
  const distBinExists = await fsp.access(BIN_SRC).then(() => true).catch(() => false);
  const distDaemonBinExists = await fsp.access(DAEMON_BIN_SRC).then(() => true).catch(() => false);

  if (!nodeModulesExists) await runCommand('npm install', 'Failed to install dependencies');
  if (!distBinExists || !distDaemonBinExists) await runCommand('npm run build', 'Failed to build binaries');

  if (!binExists) {
    await fsp.mkdir(BIN_DIR, { recursive: true });
    await fsp.copyFile(BIN_SRC, path.join(BIN_DIR, BIN_NAME));
    if (!isWindows) await fsp.chmod(path.join(BIN_DIR, BIN_NAME), '755');
    console.log(`Alias '${BIN_NAME}' set up at ${BIN_DIR}`);
  }

  if (!daemonBinExists) {
    await fsp.mkdir(BIN_DIR, { recursive: true });
    await fsp.copyFile(DAEMON_BIN_SRC, path.join(BIN_DIR, DAEMON_BIN_NAME));
    if (!isWindows) await fsp.chmod(path.join(BIN_DIR, DAEMON_BIN_NAME), '755');
    console.log(`Alias '${DAEMON_BIN_NAME}' set up at ${BIN_DIR}`);
  }

  console.log('Installation completed');
  process.exit(0);
}

async function uninstall() {
  try {
    if (await isDaemonRunning()) await stopDaemonWrapper();
    await fsp.rm(BIN_DIR, { recursive: true, force: true });
    await fsp.rm(APP_DIR, { recursive: true, force: true });
    console.log('Uninstalled successfully');
    process.exit(0);
  } catch (err) {
    const msg = `Error uninstalling: ${err.message}`;
    await logError(msg);
    console.error(msg);
    process.exit(1);
  }
}

async function openDir() {
  try {
    await ensureAppDir();
    const files = await fsp.readdir(APP_DIR).catch(() => []);
    console.log(`Opening ${APP_DIR}`);
    console.log('Program files:');
    if (files.length === 0) console.log('- (empty)');
    else for (const file of files) console.log(`- ${file}`);
    const cmd = isWindows ? `explorer "${APP_DIR}"` : isMacOS ? `open "${APP_DIR}"` : `xdg-open "${APP_DIR}"`;
    exec(cmd, (err) => {
      if (err) {
        const msg = `Error opening directory: ${err.message}`;
        logError(msg);
        console.error(msg);
        process.exit(1);
      }
    });
    process.exit(0);
  } catch (err) {
    const msg = `Error accessing directory: ${err.message}`;
    await logError(msg);
    console.error(msg);
    process.exit(1);
  }
}

async function startDaemonWrapper() {
  if (await isDaemonRunning()) {
    console.log('Daemon is already running');
    process.exit(0);
  }
  console.log('Starting daemon...');
  try {
    const daemon = spawn(DAEMON_BIN_SRC, ['--daemon'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stdout.pipe(fs.createWriteStream(path.join(APP_DIR, 'wo.log'), { flags: 'a' }));
    daemon.stderr.pipe(fs.createWriteStream(path.join(APP_DIR, 'wo.log'), { flags: 'a' }));
    await fsp.writeFile(PID_FILE, daemon.pid.toString());
    console.log(`Daemon started with PID ${daemon.pid}`);
    daemon.unref();
    process.exit(0);
  } catch (err) {
    await logError(`Failed to start daemon: ${err.message}`);
    console.error(`Failed to start daemon: ${err.message}`);
    process.exit(1);
  }
}

async function stopDaemonWrapper() {
  try {
    if (await isDaemonRunning()) {
      const pid = await fsp.readFile(PID_FILE, 'utf8');
      process.kill(parseInt(pid), 'SIGTERM');
      await fsp.unlink(PID_FILE);
      console.log('Daemon stopped');
    } else {
      console.log('Daemon not running');
    }
    process.exit(0);
  } catch (err) {
    await logError(`Failed to stop daemon: ${err.message}`);
    console.error(`Failed to stop daemon: ${err.message}`);
    process.exit(1);
  }
}

async function reloadDaemonWrapper() {
  try {
    console.log('Reloading daemon...');
    if (await isDaemonRunning()) await stopDaemonWrapper();
    await startDaemonWrapper();
    console.log('Daemon reloaded');
  } catch (err) {
    const msg = `Failed to reload daemon: ${err.message}`;
    await logError(msg);
    console.error(msg);
    process.exit(1);
  }
}

async function createConfig(originalName) {
  await ensureUserscriptsDir();
  const sanitizedName = sanitizeFilename(originalName);
  const configContent = CONFIG_TEMPLATE.replace('#NAME#', originalName);
  await fsp.writeFile(path.join(USERSCRIPTS_DIR, `${sanitizedName}.env`), configContent);
  console.log(`Created userscripts/${sanitizedName}.env`);
  process.exit(0);
}

ensureAppDir().then(() => {
  if (!isSystemDir) {
    program
      .command('install')
      .description('Install dependencies, build binaries and set up symlinks in ~/.local/bin')
      .action(checkInstallation);
  } else {
    program
      .command('uninstall')
      .description('Uninstall the program and remove all related files')
      .action(uninstall);
  }

  program
    .command('open')
    .description('Open the program directory and list related files')
    .action(openDir);

  program
    .command('start')
    .description('Start the background daemon process in detached mode')
    .action(startDaemonWrapper);

  program
    .command('kill')
    .description('Stop the daemon process if it is running')
    .action(stopDaemonWrapper);

  program
    .command('status')
    .description('Show the status of the daemon (PID if running)')
    .action(async () => {
      if (await isDaemonRunning()) {
        const pid = await fsp.readFile(PID_FILE, 'utf8');
        console.log(`Daemon is running (PID: ${pid.trim()})`);
      } else {
        console.log('Daemon not running');
      }
      process.exit(0);
    });

  program
    .command('reload')
    .description('Restart the daemon: stop if running, then start again')
    .action(reloadDaemonWrapper);

  program
    .command('create')
    .description('Create a new userscript config (interactive name prompt)')
    .action(async () => {
      try {
        const name = await new Promise(resolve => readline.question('Enter config name: ', resolve));
        await createConfig(name);
        process.exit(0);
      } catch (err) {
        const msg = `Error creating config: ${err.message}`;
        await logError(msg);
        console.error(msg);
        process.exit(1);
      } finally {
        readline.close();
      }
    });

  program
    .command('list')
    .description('List all available config files in userscripts directory')
    .action(async () => {
      try {
        await ensureUserscriptsDir();
        const files = await fsp.readdir(USERSCRIPTS_DIR);
        for (const file of files) {
          if (file.endsWith('.env')) {
            const config = dotenv.parse(await fsp.readFile(path.join(USERSCRIPTS_DIR, file)));
            console.log(config.name || file);
          }
        }
        process.exit(0);
      } catch (err) {
        const msg = `Error listing configs: ${err.message}`;
        await logError(msg);
        console.error(msg);
        process.exit(1);
      }
    });

  program
    .command('run <name>')
    .description('Run a specific config manually by name (without scheduling)')
    .action(async (name) => {
      const configPath = path.join(USERSCRIPTS_DIR, `${sanitizeFilename(name)}.env`);
      try {
        await fsp.access(configPath);
        const config = await loadConfig(configPath);
        await runTask({ file: `${name}.env`, config }, true);
        process.exit(0);
      } catch (err) {
        const msg = `Error running config ${name}: ${err.message}`;
        await logError(msg);
        console.error(msg);
        process.exit(1);
      }
    });

  program.parse();
});