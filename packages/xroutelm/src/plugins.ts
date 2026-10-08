import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RouteTarget } from './types.js';

/**
 * xRouteLM plugin system.
 *
 * A plugin is a directory containing `xroutelm.plugin.json`:
 *
 * {
 *   "name": "my-plugin",
 *   "description": "Extra routing targets",
 *   "targets": [
 *     { "id": "deploy-canary", "description": "Canary deploy gate checks",
 *       "keywords": ["deploy", "canary", "rollout"] }
 *   ]
 * }
 *
 * Plugins contribute route targets (and, in future revisions, scorers).
 * Discovery order: local project (./xroutelm.plugins/, ./.xroutelm.json),
 * then the user directory (~/.xroutelm/plugins/). Malformed manifests are
 * reported, never silently skipped.
 */

export interface PluginManifest {
  name: string;
  description: string;
  targets?: RouteTarget[];
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  errors: string[];
}

const MANIFEST_NAME = 'xroutelm.plugin.json';

function readManifest(dir: string): LoadedPlugin {
  const path = join(dir, MANIFEST_NAME);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PluginManifest;
    const errors: string[] = [];
    if (typeof parsed.name !== 'string' || parsed.name.length === 0) errors.push('missing "name"');
    if (typeof parsed.description !== 'string') errors.push('missing "description"');
    if (parsed.targets !== undefined) {
      if (!Array.isArray(parsed.targets)) errors.push('"targets" must be an array');
      else {
        parsed.targets.forEach((t, i) => {
          if (typeof t.id !== 'string' || t.id.length === 0) errors.push(`targets[${i}].id missing`);
          if (typeof t.description !== 'string') errors.push(`targets[${i}].description missing`);
        });
      }
    }
    return { manifest: parsed, path, errors };
  } catch (e) {
    return { manifest: { name: dir, description: '' }, path, errors: [`unreadable manifest: ${(e as Error).message}`] };
  }
}

/** Discover plugin manifests in the documented search paths. */
export function discoverPlugins(cwd: string): LoadedPlugin[] {
  const found: LoadedPlugin[] = [];
  const localPluginDir = join(cwd, 'xroutelm.plugins');
  if (existsSync(localPluginDir) && readdirSync(localPluginDir, { withFileTypes: true }).some((d) => d.isDirectory())) {
    for (const dirent of readdirSync(localPluginDir, { withFileTypes: true })) {
      if (dirent.isDirectory() && existsSync(join(localPluginDir, dirent.name, MANIFEST_NAME))) {
        found.push(readManifest(join(localPluginDir, dirent.name)));
      }
    }
  }
  if (existsSync(join(cwd, MANIFEST_NAME))) {
    found.push(readManifest(cwd));
  }
  const userDir = join(homedir(), '.xroutelm', 'plugins');
  if (existsSync(userDir)) {
    for (const dirent of readdirSync(userDir, { withFileTypes: true })) {
      if (dirent.isDirectory() && existsSync(join(userDir, dirent.name, MANIFEST_NAME))) {
        found.push(readManifest(join(userDir, dirent.name)));
      }
    }
  }
  return found;
}

/** Merge default targets with plugin targets (plugin ids are namespaced). */
export function targetsWithPlugins(base: RouteTarget[], plugins: LoadedPlugin[], cwd: string): { targets: RouteTarget[]; errors: string[] } {
  const errors: string[] = [];
  const extras: RouteTarget[] = [];
  for (const p of plugins) {
    errors.push(...p.errors.map((e) => `${p.path}: ${e}`));
    for (const t of p.manifest.targets ?? []) {
      extras.push({ ...t, id: t.id.includes(':') ? t.id : resolve(cwd) === resolve(p.path) ? t.id : `${p.manifest.name}:${t.id}` });
    }
  }
  return { targets: [...base, ...extras], errors };
}
