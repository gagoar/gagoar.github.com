#!/usr/bin/env node
// Refreshes the plugin list and the open-source list in index.html from GitHub.
//
//   node scripts/build.mjs          rewrite index.html
//   node scripts/build.mjs --check  exit 1 if index.html is stale
//
// Plugins: the catalog that gagoar/gago-plugins publishes (one entry per marketplace plugin).
// Open source: public, non-fork, non-archived repos with the `showcase` topic, most stars first.
// Description, stars and latest release tag come from the GitHub API. Nothing is typed by hand.
// Reads public data only. Uses GITHUB_TOKEN when set, to lift the rate limit.
//
// Repos with no push for MAX_AGE_DAYS (default 730) drop off the open-source list.
//
// Env: OWNER (default gagoar), CATALOG_URL, SHOWCASE_TOPIC (default showcase), MAX_AGE_DAYS.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = process.env.OWNER ?? 'gagoar';
const CATALOG_URL = process.env.CATALOG_URL ?? `https://${OWNER}.github.io/gago-plugins/catalog.json`;
const SHOWCASE_TOPIC = process.env.SHOWCASE_TOPIC ?? 'showcase';
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS ?? 730);
const check = process.argv.includes('--check');
const indexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');

const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function gh(path, { allow404 = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (allow404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

// Monorepo tags look like `unmistakable--v0.2.4`. Show only the version.
const version = (tag) => tag?.match(/v?\d[\w.+-]*$/)?.[0].replace(/^(?=\d)/, 'v');

const fullName = (url) => url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');

async function plugins() {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`catalog ${CATALOG_URL}: ${res.status}`);
  const catalog = await res.json();
  const items = await Promise.all(
    catalog.plugins.map(async (p) => {
      const name = fullName(p.repo);
      const [repo, release] = await Promise.all([gh(`/repos/${name}`), gh(`/repos/${name}/releases/latest`, { allow404: true })]);
      return { name: repo.name, href: p.docs.endsWith('/') ? p.docs : `${p.docs}/`, description: repo.description ?? p.description, tag: version(release?.tag_name), pushed: repo.pushed_at, repoName: name.toLowerCase() };
    }),
  );
  return items.sort((a, b) => b.pushed.localeCompare(a.pushed));
}

async function showcase(pluginRepos) {
  const q = encodeURIComponent(`user:${OWNER} topic:${SHOWCASE_TOPIC} fork:false archived:false`);
  const { items } = await gh(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=100`);
  return items
    .filter((r) => !pluginRepos.has(r.full_name.toLowerCase()))
    .filter((r) => Date.now() - Date.parse(r.pushed_at) < MAX_AGE_DAYS * 86_400_000)
    .map((r) => ({ name: r.name, href: r.homepage || r.html_url, description: r.description ?? '', stars: r.stargazers_count }));
}

const pluginItem = (p) =>
  `<li class="gg-item"><h3><a href="${esc(p.href)}">${esc(p.name)}</a>${p.tag ? `<span class="gg-tag">${esc(p.tag)}</span>` : ''}</h3><p>${esc(p.description)}</p></li>`;
const ossItem = (r) =>
  `<li class="gg-item"><h3><a href="${esc(r.href)}">${esc(r.name)}</a><span class="gg-stars">${r.stars}<span class="gg-sr"> stars</span></span></h3><p>${esc(r.description)}</p></li>`;

function replaceRegion(text, name, body) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(text)) throw new Error(`index.html has no <!-- ${name}:start --> ... <!-- ${name}:end --> markers`);
  return text.replace(re, (_, a, b) => `${a}${body}${b}`);
}

const pluginList = await plugins();
const ossList = await showcase(new Set(pluginList.map((p) => p.repoName)));

// A topic typo or an API hiccup must not blank a section on the live site.
if (!pluginList.length) throw new Error('refusing to publish an empty plugin list');
if (!ossList.length) throw new Error(`refusing to publish an empty open-source list: no repo has the "${SHOWCASE_TOPIC}" topic`);

const prev = readFileSync(indexPath, 'utf8');
let next = replaceRegion(prev, 'plugins', `\n${pluginList.map(pluginItem).join('\n')}\n`);
next = replaceRegion(next, 'oss', `\n${ossList.map(ossItem).join('\n')}\n`);
// The date line changes only when the lists do, so a no-op run leaves no diff.
if (next !== prev) next = replaceRegion(next, 'asof', new Date().toISOString().slice(0, 10));

if (next === prev) {
  console.log('ok: index.html is current');
} else if (check) {
  console.error('stale: index.html. Run: node scripts/build.mjs');
  process.exit(1);
} else {
  writeFileSync(indexPath, next);
  console.log(`updated index.html: ${pluginList.length} plugins, ${ossList.length} open-source repos`);
}
