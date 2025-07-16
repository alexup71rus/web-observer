const CONFIG_TEMPLATE = `# Parser configuration
name=#NAME# # Original config name
ollama_host=http://localhost:11434 # Ollama server host (optional, defaults to http://localhost:11434)
model=llama3 # Ollama model (e.g., llama3, mistral)
prompt=Summarize this content: {content} # Prompt for Ollama, must include {content}
duration=* * * * * # Schedule: cron expression (e.g., '* * * * *' for every minute, '0 12 * * *' for daily at 12:00), dd.mm.yy hh.mm for one-time (e.g., 15.07.25 12.00), hh.mm for daily (e.g., 15.30), empty for manual run
tags=body > div,!.promo # CSS selectors to include/exclude (e.g., "body > div", "div.container > p:not(.ad)", "!.promo" to exclude)
url=https://example.com # Target URL to parse (e.g., https://example.com)
`;

module.exports = { CONFIG_TEMPLATE };