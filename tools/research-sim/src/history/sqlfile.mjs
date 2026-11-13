// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Adam K. Dean

// Loads the SQL files under sql/ and fills in run parameters. The format and
// the typed literals are the extraction tool's (tools/research-corpus,
// src/sqlfile.mjs), so a query reads the same in both tools.
//
// A file is a sequence of blocks. A block starts at a line
//   -- @step <name>      statements the runner executes as one resumable step
//   -- @query <name>     one statement whose rows the driver reads
//   -- @lib <name>       statements that define functions; executed like a step
// and runs to the next such line or the end of the file. Text before the first
// block is the file's header comment. Inside a step, the line
//   -- @outputs study.a study.b
// names the tables the step builds (the runner marks them with the run id).
//
// Placeholders are {{name}}. Each one is replaced by a typed SQL literal built
// from the run parameters (see literal() below); an unknown name or a value of
// the wrong type is an error, never an empty string. Parameters come from the
// driver, not from the database or a user string, and every literal is checked
// against its type before it is written.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');

const BLOCK = /^--\s*@(step|query|lib)\s+([a-z0-9_]+)\s*$/;
const OUTPUTS = /^--\s*@outputs\s+(.+)$/;

export function parseSqlFile(text, file = '<inline>') {
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${file}: byte-order mark`);
  if (text.includes('\r')) throw new Error(`${file}: CR line ending`);
  const lines = text.split('\n');
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = BLOCK.exec(line);
    if (m) {
      cur = { kind: m[1], name: m[2], file, outputs: [], lines: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    const o = OUTPUTS.exec(line);
    if (o) {
      cur.outputs.push(...o[1].trim().split(/\s+/));
      continue;
    }
    cur.lines.push(line);
  }
  for (const b of blocks) {
    b.text = b.lines.join('\n').trim();
    delete b.lines;
    b.statements = splitStatements(b.text);
    if (b.kind === 'query' && b.statements.length !== 1) {
      throw new Error(`${file}: query ${b.name} must be one statement, found ${b.statements.length}`);
    }
  }
  return blocks;
}

// Splits on semicolons outside quotes, dollar quotes and comments.
export function splitStatements(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const e = sql.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      if (e < 0) throw new Error('unterminated block comment');
      i = e + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error('unterminated quote');
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const e = sql.indexOf(tag, i + tag.length);
        if (e < 0) throw new Error(`unterminated dollar quote ${tag}`);
        i = e + tag.length;
      } else i++;
    } else if (c === ';') {
      const s = sql.slice(start, i).trim();
      if (stripComments(s)) out.push(s);
      i++;
      start = i;
    } else i++;
  }
  const s = sql.slice(start).trim();
  if (stripComments(s)) out.push(s);
  return out;
}

function stripComments(s) {
  return s
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

// Typed parameters: { type, value }.
//   int     a safe integer or a bigint, written as a decimal literal
//   num     a decimal string or number, written as a numeric literal
//   bool    true or false
//   bytea   lowercase or uppercase hex, written as decode('...', 'hex'), which
//           reads the same whatever standard_conforming_strings is
//   text    any string without a NUL, single quotes doubled
//   ident   a plain lowercase identifier, written as is (table and column names)
//   intarr  an array of integers, written as ARRAY[...]::bigint[]
//   bytearr an array of hex strings, written as ARRAY[...]::bytea[]
//   int4arr an array of integers, written as ARRAY[...]::integer[]
export function literal(name, p) {
  if (!p || typeof p !== 'object' || !('type' in p)) throw new Error(`parameter ${name}: missing or untyped`);
  const v = p.value;
  switch (p.type) {
    case 'int': {
      const s = typeof v === 'bigint' ? v.toString() : String(v);
      if (!/^-?\d+$/.test(s)) throw new Error(`parameter ${name}: not an integer: ${s}`);
      return s;
    }
    case 'num': {
      const s = String(v);
      if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`parameter ${name}: not a decimal: ${s}`);
      return `${s}::numeric`;
    }
    case 'bool':
      if (v !== true && v !== false) throw new Error(`parameter ${name}: not a boolean`);
      return v ? 'true' : 'false';
    case 'bytea':
      if (typeof v !== 'string' || !/^([0-9a-fA-F]{2})*$/.test(v)) throw new Error(`parameter ${name}: not hex`);
      return `decode('${v.toLowerCase()}', 'hex')`;
    case 'text':
      if (typeof v !== 'string' || v.includes('\0')) throw new Error(`parameter ${name}: not text`);
      return `'${v.replace(/'/g, "''")}'`;
    case 'ident':
      if (typeof v !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(v)) throw new Error(`parameter ${name}: not an identifier`);
      return v;
    case 'intarr':
      if (!Array.isArray(v)) throw new Error(`parameter ${name}: not an array`);
      return `ARRAY[${v.map((x, k) => literal(`${name}[${k}]`, { type: 'int', value: x })).join(',')}]::bigint[]`;
    case 'bytearr':
      if (!Array.isArray(v)) throw new Error(`parameter ${name}: not an array`);
      return `ARRAY[${v.map((x, k) => literal(`${name}[${k}]`, { type: 'bytea', value: x })).join(',')}]::bytea[]`;
    case 'int4arr':
      if (!Array.isArray(v)) throw new Error(`parameter ${name}: not an array`);
      return `ARRAY[${v.map((x, k) => literal(`${name}[${k}]`, { type: 'int', value: x })).join(',')}]::integer[]`;
    default:
      throw new Error(`parameter ${name}: unknown type ${p.type}`);
  }
}

export function fill(sql, params) {
  return sql.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_m, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) throw new Error(`unknown parameter {{${name}}}`);
    return literal(name, params[name]);
  });
}

export function placeholders(sql) {
  return [...new Set([...sql.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))];
}

export function loadSqlFile(name) {
  const file = join(SQL_DIR, name);
  return parseSqlFile(readFileSync(file, 'utf8'), name);
}

export function loadAll() {
  const files = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
  const byName = new Map();
  for (const f of files) {
    for (const b of loadSqlFile(f)) {
      if (byName.has(b.name)) throw new Error(`block ${b.name} defined twice (${byName.get(b.name).file}, ${f})`);
      byName.set(b.name, b);
    }
  }
  return byName;
}
