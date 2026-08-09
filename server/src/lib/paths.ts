import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

/** Content-addressed path for a sha256 digest. */
export function contentPath(sha256: string): string {
  return path.join(config.storageDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureContentDirs(sha256: string): string {
  const p = contentPath(sha256);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

export function contentExists(sha256: string, size: number): boolean {
  try {
    return fs.statSync(contentPath(sha256)).size === size;
  } catch {
    return false;
  }
}

/** Build a slash-joined relative path for an item in the tree. */
export function itemPath(parts: { name: string }[]): string {
  return parts.map((p) => p.name).join('/');
}
