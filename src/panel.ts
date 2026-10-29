import { readFileSync, existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';

const built = new URL('../dist/panel/', import.meta.url);
const source = new URL('../web/', import.meta.url);
const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/panel.js': ['panel.js', 'text/javascript; charset=utf-8'],
  '/panel.css': ['panel.css', 'text/css; charset=utf-8'],
};
export function panelAsset(path: string, res: ServerResponse): boolean {
  const asset = assets[path]; if (!asset) return false;
  const root = existsSync(new URL('index.html', built)) ? built : source;
  const file = new URL(asset[0], root);
  if (!existsSync(file)) { res.writeHead(503); res.end('Run npm run build to prepare the panel.'); return true; }
  res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-cache' });
  res.end(readFileSync(file)); return true;
}
