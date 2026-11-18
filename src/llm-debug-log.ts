import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const credentialSuffix = /api[-_ ]?key|auth(?:orization)?(?:[-_ ]?(?:token|key))?|password|passwd|secret(?:[-_ ]?(?:key|access[-_ ]?key))?|token|(?:private|signing|encryption)[-_ ]?key|access[-_ ]?key(?:[-_ ]?id)?|session[-_ ]?id|credentials?|cookie/;
const credentialName = new RegExp(`(?:^key|${credentialSuffix.source})$`, "i");
const assignment = new RegExp(String.raw`(?<![\w-])(key|[\w-]*(?:${credentialSuffix.source}))(["']?\s*[:=]\s*)(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:(?:Bearer|Basic)\s+)?[^\s,;&}]+))`, "gi");
const masked = (value: string) => (value.length > 6 ? value.slice(0, 6) : "") + "***";

function maskCredential(value: string): string {
  const auth = /^(Bearer|Basic)\s+(.+)$/is.exec(value);
  return auth ? auth[1] + " " + masked(auth[2]!) : masked(value);
}

function redactText(text: string, secrets: string[]): string {
  let clean = text
    .replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g, value => masked(value))
    .replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)(:\s*)([^\r\n]+)/gi,
      (_match, name, sep, value) => name + sep + maskCredential(value))
    .replace(assignment, (_match, name, separator, double, single, bare) => {
      const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
      return name + separator + quote + maskCredential(double ?? single ?? bare) + quote;
    })
    .replace(/\b(Bearer|Basic)(\s+)([\w.*+/=~-]+)/gi,
      (_match, scheme, space, value) => scheme + space + masked(value))
    .replace(/(:\/\/[^\s/:@]+:)([^\s/@]+)(?=@)/g, (_match, prefix, password) => prefix + masked(password))
    .replace(/\b(?:sk-(?:or-v1-)?[\w-]{8,}|gh[pousr]_[\w]{12,}|github_pat_[\w]+|xox[baprs]-[\w-]+|AKIA[A-Z0-9]{16}|AIza[\w-]{35}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, value => masked(value));
  for (const secret of secrets) clean = clean.replaceAll(secret, () => masked(secret));
  return clean;
}

// Rewrite only credential-bearing tokens. Keeping the other original lexemes preserves
// whitespace, escapes, duplicate properties and numeric precision in provider responses.
function redactJson(json: string, secrets: string[]): string {
  let sensitive = false;
  let hiddenDepth = 0;
  return json.replace(/"(?:\\[\s\S]|[^"\\])*"(?:\s*:)?|[{}\[\],]|[^\s"{}\[\],:]+/g, token => {
    const opens = token === "{" || token === "[";
    if (hiddenDepth) {
      if (opens) hiddenDepth++;
      if (token === "}" || token === "]") hiddenDepth--;
      return "";
    }
    if (sensitive) {
      sensitive = false;
      if (opens) hiddenDepth = 1;
      return JSON.stringify(opens ? "***" : maskCredential(token.startsWith('"') ? JSON.parse(token) : token));
    }
    if (!token.startsWith('"')) {
      const isScalar = !opens && token !== "}" && token !== "]" && token !== ",";
      return isScalar && secrets.includes(token) ? JSON.stringify(masked(token)) : token;
    }
    const isKey = token.endsWith(":");
    const literal = isKey ? token.slice(0, token.lastIndexOf('"') + 1) : token;
    const value: string = JSON.parse(literal);
    sensitive = isKey && credentialName.test(value);
    let clean = value;
    // OpenRouter encodes tool arguments, results and structured assistant content as strings.
    if (!isKey && /^\s*[[{]/.test(value)) {
      let isJson = true;
      try { JSON.parse(value); } catch { isJson = false; }
      clean = isJson ? redactJson(value, secrets) : redactText(value, secrets);
    } else clean = redactText(value, secrets);
    return clean === value ? token : JSON.stringify(clean) + token.slice(literal.length);
  });
}

export function createLlmDebugLog(apiKey: string) {
  if ((process.env.LLM_DEBUG_LOG ?? "true").trim().toLowerCase() !== "true") return;
  const run = resolve(".microbiz", "logs", new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID());
  const secrets = [...new Set([apiKey, ...Object.entries(process.env)
    .filter(([name]) => credentialName.test(name)).map(([, value]) => value).filter((v): v is string => !!v)])]
    .sort((a, b) => b.length - a.length);
  let number = 0;
  let failed = false;
  function write(file: string, json: string) {
    if (failed) return;
    try {
      const clean = redactJson(json, secrets);
      mkdirSync(run, { recursive: true, mode: 0o700 });
      writeFileSync(join(run, file), clean, { flag: "wx", mode: 0o600 });
    } catch {
      failed = true;
      console.warn("Could not write the local LLM debug log. Logging disabled for this run.");
    }
  }
  return (body: string) => {
    const prefix = String(++number).padStart(3, "0");
    write(prefix + "-request.json", body);
    return (raw: string) => write(prefix + "-response.json", raw);
  };
}
