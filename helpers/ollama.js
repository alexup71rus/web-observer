const ollama = require('ollama');
const { logResult, logDaemon } = require('./log');

async function processWithOllama(model, prompt, content, ollama_host = 'http://localhost:11434') {
  try {
    if (typeof model !== 'string' || !model.trim()) throw new Error('Model must be a non-empty string');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt must be a non-empty string');
    if (typeof content !== 'string') throw new Error('Content must be a string');
    if (!prompt.includes('{content}')) throw new Error('Prompt must include {content}');
    if (!/https?:\/\/.+/.test(ollama_host)) throw new Error('Invalid ollama_host URL');

    await logDaemon(`Starting Ollama processing with model ${model}`);
    const client = new ollama.Ollama({ host: ollama_host });

    try {
      await client.list();
    } catch (err) {
      throw new Error(`Ollama server is not reachable: ${err.message}`);
    }

    const response = await client.generate({
      model,
      prompt: prompt.replace('{content}', content),
      stream: false
    });
    await logDaemon(`Ollama processing with model ${model} completed`);
    return response.response;
  } catch (err) {
    console.error('Ollama error:', err.message);
    await logDaemon(`Ollama error: ${err.message}`);
    return 'Error processing with Ollama';
  }
}

module.exports = { processWithOllama };