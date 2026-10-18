#!/usr/bin/env node
import { createRequire as __lexiconCreateRequire } from "node:module";
const require = __lexiconCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target2) => (target2 = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target2, "default", { value: mod, enumerable: true }) : target2,
  mod
));

// builtin-cjs:node:module
var require_node_module = __commonJS({
  "builtin-cjs:node:module"(exports, module) {
    module.exports = __require("node:module");
  }
});

// builtin-cjs:node:path
var require_node_path = __commonJS({
  "builtin-cjs:node:path"(exports, module) {
    module.exports = __require("node:path");
  }
});

// builtin-cjs:node:os
var require_node_os = __commonJS({
  "builtin-cjs:node:os"(exports, module) {
    module.exports = __require("node:os");
  }
});

// src/hooks/plugin-entry.ts
var import_node_module = __toESM(require_node_module(), 1);
var import_node_path2 = __toESM(require_node_path(), 1);

// src/util/xdg.ts
var import_node_path = __toESM(require_node_path());
var import_node_os = __toESM(require_node_os());
function absoluteOr(value, fallback) {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return import_node_path.default.isAbsolute(trimmed) ? trimmed : fallback;
}
function xdgConfigHome(env = process.env, home = import_node_os.default.homedir()) {
  return absoluteOr(env.XDG_CONFIG_HOME, import_node_path.default.join(home, ".config"));
}
function globalLexiconPath(env = process.env, home = import_node_os.default.homedir()) {
  return env.LEXICON_PATH || import_node_path.default.join(xdgConfigHome(env, home), "lexicon", "lexicon.yaml");
}

// src/hooks/plugin-entry.ts
var COMPILE_CACHE_DIR_NAME = "node-compile-cache";
function enableCompileCache() {
  try {
    const enable = import_node_module.default.enableCompileCache;
    if (typeof enable !== "function") return;
    enable(import_node_path2.default.join(import_node_path2.default.dirname(import_node_path2.default.resolve(globalLexiconPath())), COMPILE_CACHE_DIR_NAME));
  } catch {
  }
}
enableCompileCache();
var target = new URL("./hook-main.mjs", import.meta.url).href;
try {
  const hook = await import(target);
  await hook.main();
} catch (err) {
  process.stderr.write(`lexicon hook: ${err instanceof Error ? err.message : String(err)}
`);
  process.exitCode = 0;
}
export {
  COMPILE_CACHE_DIR_NAME
};
