/**
 * The tokenizer contract this server's retrieval rests on.
 *
 * `@edgeorgie/retrieval-core` is a git dependency pinned by SHA in the
 * lockfile, and `vocab`/`idf` for the whole corpus are derived entirely from
 * its `tokenize()`. Before this file existed, nothing here had any sensor for
 * that dependency's behaviour: restoring the pre-fix unfiltered sub-token push
 * inside node_modules left this repo's suite **38/38 green**, and `tsc`,
 * `build`, `npm audit` and the deploy check were green in both states. So PR
 * #20 cited "npm test -> 38/38" under a *Verified* heading as evidence for a
 * tokenizer fix, and that number carried no information about the tokenizer
 * at all. A future upstream change that destroyed retrieval quality would
 * have passed CI.
 *
 * Both assertions below are deliberately BEHAVIOURAL — what the tokenizer must
 * and must not emit for this corpus to be searchable — rather than a
 * restatement of its implementation, so they survive refactors upstream and
 * fail on real regressions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "@edgeorgie/retrieval-core";

test("tokenize splits identifiers, so prose questions share vocabulary with code", () => {
  // The corpus includes project/source material written in camelCase. Without
  // splitting, `getUserName` is one opaque token and a prose question shares NO
  // vocabulary with the chunk defining it — the chunk is unretrievable, not
  // merely mis-ranked.
  const camel = tokenize("getUserName");
  assert.ok(camel.includes("user"), `expected a "user" sub-token: ${JSON.stringify(camel)}`);
  assert.ok(camel.includes("name"), `expected a "name" sub-token: ${JSON.stringify(camel)}`);

  // Consecutive capitals are a separate code path that was broken independently
  // of the first-pass camelCase split.
  const acronym = tokenize("HTTPServer");
  assert.ok(acronym.includes("http"), `expected an "http" sub-token: ${JSON.stringify(acronym)}`);
  assert.ok(acronym.includes("server"), `expected a "server" sub-token: ${JSON.stringify(acronym)}`);

  // The whole token must survive too, or exact-symbol search breaks. The
  // emitted vocabulary is a strict superset of the pre-split behaviour.
  assert.ok(
    camel.includes("getusername"),
    `the whole identifier must remain searchable: ${JSON.stringify(camel)}`,
  );
});

test("tokenize does not leak stopwords in through the sub-token path", () => {
  // Case splitting opened a back door around the stopword filter, which applied
  // only to whole tokens: `toString` emitted "to", `isValid` emitted "is",
  // `canRetry` emitted "can". Those terms occur in nearly every identifier, so
  // they consumed vocabulary slots at a near-zero IDF while adding noise to
  // every vector in the corpus.
  for (const [identifier, leaked, kept] of [
    ["toString", "to", "string"],
    ["isValid", "is", "valid"],
    ["canRetry", "can", "retry"],
    ["of_the_thing", "the", "thing"],
  ] as const) {
    const tokens = tokenize(identifier);
    assert.ok(
      !tokens.includes(leaked),
      `"${identifier}" leaked stopword "${leaked}": ${JSON.stringify(tokens)}`,
    );
    // Paired positive assertion: the leak check alone is satisfiable by a
    // tokenizer that simply drops short sub-tokens, which would undo the split
    // the test above requires. Asserting both pins the real behaviour.
    assert.ok(
      tokens.includes(kept),
      `"${identifier}" lost the meaningful sub-token "${kept}": ${JSON.stringify(tokens)}`,
    );
  }
});
