import privacy from "./privacy.md?raw";
import terms from "./terms.md?raw";

export interface LegalDoc {
  version: string;
  content: string;
}

function parse(raw: string): LegalDoc {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) throw new Error("legal document is missing frontmatter");
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  if (!meta.version) throw new Error("legal document frontmatter is missing version");
  return { version: meta.version, content: raw.slice(match[0].length).trimStart() };
}

export const LEGAL_DOCS: Record<string, LegalDoc> = {
  terms: parse(terms),
  privacy: parse(privacy),
};

export const TERMS_VERSION = LEGAL_DOCS.terms.version;
