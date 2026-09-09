// Keys whose *children's names* are caller-chosen rather than schema keywords, and keys whose
// values are literal payloads rather than schemas. Shared by both strippers below: each one has
// to tell "the keyword `x`" apart from "a property someone named `x`".
const SCHEMA_NAME_BAG_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
]);
const SCHEMA_LITERAL_VALUE_KEYS = new Set(["const", "default", "enum", "examples"]);

/**
 * `patternProperties` is the one name bag whose keys are not just names: each key is itself a
 * regex the destination compiles. So the Unicode-property problem applies to the key as well as
 * to a `pattern` value, and a bag copied verbatim would still fail the whole schema.
 */
const PATTERN_KEYED_BAG_KEY = "patternProperties";

/**
 * Codex multi-agent v2 stamps a Responses-only `encrypted: true` marker on collaboration tool
 * schemas (openai/codex 5f4d06ef; issue #85). It is an annotation for the ChatGPT backend only,
 * so translated provider schemas must drop it without removing properties or definitions
 * literally named `encrypted`.
 *
 * The schema is caller-supplied, so its nesting depth is attacker-influenced. Native recursion
 * would turn a deep schema into a stack overflow that takes down the request path, so this walks
 * an explicit stack instead: depth costs heap, which is bounded and recoverable.
 */
export function stripResponsesOnlyEncryptedMarker(node: unknown, inNameBag = false): unknown {
  type Assign = (value: unknown) => void;
  interface Frame { node: unknown; inNameBag: boolean; assign: Assign }

  let result: unknown;
  const stack: Frame[] = [{ node, inNameBag, assign: value => { result = value; } }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const current = frame.node;

    if (Array.isArray(current)) {
      const out: unknown[] = new Array(current.length);
      frame.assign(out);
      // Array items are schemas in their own right, never a name bag.
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push({ node: current[i], inNameBag: false, assign: value => { out[i] = value; } });
      }
      continue;
    }
    if (!current || typeof current !== "object") {
      frame.assign(current);
      continue;
    }

    // A schema name may be `__proto__`; a null-prototype record keeps it as data.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    frame.assign(out);

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (frame.inNameBag) {
        // Inside a name bag every key is a caller-chosen name, so `encrypted` here is data.
        stack.push({ node: value, inNameBag: false, assign: v => { out[key] = v; } });
      } else if (key !== "encrypted") {
        if (SCHEMA_LITERAL_VALUE_KEYS.has(key)) {
          // Literal payloads are values, not schemas: an `encrypted` key inside them is data.
          out[key] = value;
        } else {
          const childInNameBag = SCHEMA_NAME_BAG_KEYS.has(key);
          stack.push({ node: value, inNameBag: childInNameBag, assign: v => { out[key] = v; } });
        }
      }
    }
  }

  return result;
}

/**
 * `\p{…}` is an escape only when the backslash introducing it is itself unescaped: in `\\p{2}`
 * the pair is a literal backslash and the `p{2}` that follows is an ordinary quantified `p`,
 * which Python compiles fine. Scanning for the raw substring would misread that as a property
 * escape and discard a working pattern.
 */
function usesUnicodePropertyEscape(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue;
    const next = pattern[i + 1];
    if (next === "\\") {
      i++;
      continue;
    }
    if ((next === "p" || next === "P") && pattern[i + 2] === "{") return true;
  }
  return false;
}

/**
 * ECMA-262 regexes may use Unicode property escapes (`\p{Cc}`, `\P{L}`); Python's `re` cannot
 * compile them. OpenAI-family upstreams validate a function tool's JSON Schema `pattern` by
 * compiling it with `re`, so a schema authored in JavaScript is refused whole, before routing:
 *
 *   Invalid schema for function 'Artifact':
 *   '^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$' is not a 'regex'.
 *
 * A client that ships such a pattern on a built-in tool therefore loses every request, not just
 * the calls to that tool — Claude Code 2.1.265 does exactly this on its `Artifact` tool.
 * Dropping only the patterns the destination cannot compile keeps the tool's shape while letting
 * the request through, the same trade the Kiro adapter makes for the validation keywords Bedrock
 * rejects. What is given up is bounded: an upstream that enforces `pattern` does so under strict
 * Structured Outputs, and a pattern this function drops is one that upstream could not have
 * compiled in the first place — it refuses the whole schema before any argument is generated. So
 * the choice is a dropped constraint versus no request at all, not a silently weakened one that
 * would otherwise have been enforced.
 *
 * Returns `node` itself when nothing was dropped, so callers can use identity to tell whether
 * the schema changed. Walks an explicit stack for the same reason as the stripper above.
 *
 * Two shapes carry an uncompilable regex, and both are dropped: a `pattern` value, and a
 * `patternProperties` key. The key case matters because the destination compiles those keys
 * too, so preserving one would fail the schema exactly as a `pattern` value would.
 */
export function stripUnicodePropertyPatterns(node: unknown, inNameBag = false): unknown {
  type Assign = (value: unknown) => void;
  interface Frame { node: unknown; inNameBag: boolean; patternKeyed?: boolean; assign: Assign }

  let result: unknown;
  let dropped = 0;
  const stack: Frame[] = [{ node, inNameBag, assign: value => { result = value; } }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const current = frame.node;

    if (Array.isArray(current)) {
      const out: unknown[] = new Array(current.length);
      frame.assign(out);
      // Array items are schemas in their own right, never a name bag.
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push({ node: current[i], inNameBag: false, assign: value => { out[i] = value; } });
      }
      continue;
    }
    if (!current || typeof current !== "object") {
      frame.assign(current);
      continue;
    }

    // A schema name may be `__proto__`; a null-prototype record keeps it as data.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    frame.assign(out);

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (frame.inNameBag) {
        if (frame.patternKeyed && usesUnicodePropertyEscape(key)) {
          // The key is the matcher here, so an uncompilable key takes its schema with it.
          // Keeping the entry would fail the whole schema exactly as a pattern value does.
          dropped++;
          continue;
        }
        // Inside a name bag every key is a caller-chosen name, so `pattern` here is a property
        // name; its value is still a schema and is walked as one.
        stack.push({ node: value, inNameBag: false, assign: v => { out[key] = v; } });
        continue;
      }
      if (key === "pattern" && typeof value === "string" && usesUnicodePropertyEscape(value)) {
        dropped++;
        continue;
      }
      if (SCHEMA_LITERAL_VALUE_KEYS.has(key)) {
        // Literal payloads are values, not schemas: a `pattern` key inside them is data.
        out[key] = value;
        continue;
      }
      stack.push({
        node: value,
        inNameBag: SCHEMA_NAME_BAG_KEYS.has(key),
        patternKeyed: key === PATTERN_KEYED_BAG_KEY,
        assign: v => { out[key] = v; },
      });
    }
  }

  return dropped === 0 ? node : result;
}
