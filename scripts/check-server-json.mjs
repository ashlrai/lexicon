#!/usr/bin/env node
/**
 * Validates server.json — the official MCP Registry manifest — before publishing.
 *
 * Three checks, because the schema alone does not predict a successful publish:
 *
 *   1. Schema. Fetches the JSON Schema named in the file's own `$schema` field
 *      and validates the document against it (draft-07, via ajv).
 *   2. Version agreement. server.json `version`, its npm package `version` and
 *      package.json `version` must all match, so a release cannot half-land.
 *   3. npm ownership. The registry proves you own an npm package by fetching
 *      `https://registry.npmjs.org/<pkg>/<version>` and requiring an `mcpName`
 *      field equal to the server name. A published version without `mcpName`
 *      cannot be claimed, and npm forbids re-publishing over a version — so the
 *      fix is always a new patch release. This check fails loudly for that.
 *
 * Usage: node scripts/check-server-json.mjs [--offline]
 *   --offline  skip the two network checks (schema fetch, npm metadata)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.argv.includes('--offline');
const require = createRequire(import.meta.url);

const problems = [];
const notes = [];

const read = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
const server = read('server.json');
const pkg = read('package.json');

/* ---------------------------------------------------------------- 1. schema */
if (!offline) {
  let Ajv, addFormats;
  try {
    Ajv = require('ajv');
    addFormats = require('ajv-formats');
  } catch {
    problems.push('ajv / ajv-formats not resolvable. Run: npm i -D ajv ajv-formats');
  }
  if (Ajv) {
    const url = server.$schema;
    if (!url) problems.push('server.json has no $schema field, so there is nothing to validate against.');
    else {
      const res = await fetch(url);
      if (!res.ok) problems.push(`could not fetch schema ${url}: HTTP ${res.status}`);
      else {
        const schema = await res.json();
        // The published schema is draft-07 and self-references by $id; ajv rejects
        // an unknown `example` keyword under strict mode, hence strict:false.
        const ajv = new (Ajv.default ?? Ajv)({ strict: false, allErrors: true });
        addFormats(ajv);
        const validate = ajv.compile(schema);
        if (!validate(server)) {
          for (const e of validate.errors ?? []) {
            problems.push(`schema: ${e.instancePath || '/'} ${e.message}`);
          }
        } else {
          notes.push(`schema: valid against ${url}`);
        }
      }
    }
  }
}

/* -------------------------------------------------------------- 2. versions */
const npmPkg = (server.packages ?? []).find((p) => p.registryType === 'npm');
if (!npmPkg) {
  problems.push('server.json has no npm package entry, so clients cannot install without cloning.');
} else {
  if (npmPkg.identifier !== pkg.name) {
    problems.push(`npm identifier '${npmPkg.identifier}' != package.json name '${pkg.name}'`);
  }
  for (const [label, value] of [['server.version', server.version], ['package entry version', npmPkg.version]]) {
    if (value !== pkg.version) {
      problems.push(`${label} '${value}' != package.json version '${pkg.version}'`);
    }
  }
  if (!problems.length) notes.push(`versions agree at ${pkg.version}`);
}

/* --------------------------------------------------------- 3. npm ownership */
if (pkg.mcpName !== server.name) {
  problems.push(
    `package.json is missing the ownership field. Add: "mcpName": "${server.name}" ` +
      `(found ${JSON.stringify(pkg.mcpName)}).`,
  );
}

if (!offline && npmPkg) {
  const url = `https://registry.npmjs.org/${npmPkg.identifier.replace('/', '%2f')}/${npmPkg.version}`;
  const res = await fetch(url);
  if (res.status === 404) {
    problems.push(`npm has no published ${npmPkg.identifier}@${npmPkg.version} yet (${url} -> 404).`);
  } else if (!res.ok) {
    problems.push(`could not read npm metadata: ${url} -> HTTP ${res.status}`);
  } else {
    const meta = await res.json();
    if (meta.mcpName !== server.name) {
      problems.push(
        `PUBLISH WILL BE REJECTED: published ${npmPkg.identifier}@${npmPkg.version} has ` +
          `mcpName ${JSON.stringify(meta.mcpName)}, expected "${server.name}". ` +
          `npm versions are immutable, so add "mcpName" to package.json and release a new patch version.`,
      );
    } else {
      notes.push(`npm ownership: ${npmPkg.identifier}@${npmPkg.version} declares mcpName "${meta.mcpName}"`);
    }
  }
}

/* ------------------------------------------------------------------ report */
for (const n of notes) console.log(`ok    ${n}`);
if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('check:server-json: ready to publish');
