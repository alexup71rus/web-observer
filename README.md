# Web Observer

A CLI tool for scraping websites using Puppeteer and processing content with a local Ollama server.  
It supports scheduled tasks, configuration management, and cross-platform binaries for macOS and Windows.

## Features
- Scrapes websites with JavaScript execution using Puppeteer.
- Processes content with local Ollama models (e.g., `llama3`).
- Schedules tasks using `dd.mm.yy hh.mm` or `hh.mm` formats.
- Manages configs in `userscripts/*.env` with sanitized filenames.
- Builds standalone binaries with `pkg`.

## Installation
Install Node.js v18+ and Ollama, then run:  
`npm install` and `npm run build` to create binaries in `dist/`.

## Usage
Commands: `help`, `create` (prompts for config name), `list`, `reload`, `kill`.  
Configs store `name`, `ollama_host`, `model`, `prompt`, `duration`, `tags`, `url`.

## Notes
Ensure Ollama runs at `ollama_host` (default: `http://localhost:11434`).  
Licensed under ISC.