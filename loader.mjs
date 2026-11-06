// Node loader hook: lets the Worker import .html as text and .png as bytes, like Wrangler's rules.
import { readFile } from 'node:fs/promises';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.html')) {
    const text = await readFile(new URL(url), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  if (url.endsWith('.png')) {
    const b64 = (await readFile(new URL(url))).toString('base64');
    return { format: 'module', source: `export default Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0)).buffer;`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
