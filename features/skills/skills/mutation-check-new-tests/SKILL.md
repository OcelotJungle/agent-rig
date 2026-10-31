---
name: mutation-check-new-tests
description: Use when a newly written test or test group has just gone green and you are about to rely on it as a regression guard, especially for wiring, registration, config values or table lookups where a test can pass vacuously.
---

# Mutation check for new tests

A green test proves nothing until you have seen it go red for the right reason. Break the guarded
behavior on purpose, watch the test fail, then restore the code exactly.

## Steps

1. **Back up** every file you will mutate, outside the repo:
   ```bash
   cp src/pricing.ts /tmp/pricing.bak
   ```
2. **Mutate minimally**: remove the intended effect, nothing else. Typical moves:
   - replace the factor with a neutral value: `s|const total = price * (1 + taxRate);|const total = price;|`
   - short-circuit a condition: `if (x)` → `if (x && false)` or `if (x || true)`
   - zero a constant (`MAX_RETRIES = 0`), skip a registration line, return the raw input.
   Then **grep to confirm the mutation landed**; `sed` with no match succeeds silently:
   ```bash
   sed -i 's|old|new|' src/pricing.ts && grep -n "new" src/pricing.ts
   ```
3. **Run only the relevant filter** (e.g. `bun test pricing`) and confirm that
   the *specific new tests* fail, with the expected assertion message — not a compile error or an
   unrelated failure.
4. **Restore from the backup**, not by reverse-editing:
   ```bash
   cp /tmp/pricing.bak src/pricing.ts && grep -n "1 + taxRate" src/pricing.ts
   ```
   Check that `git diff` on the file shows only your intended (pre-mutation) changes and that line
   endings did not change (`file src/pricing.ts` → still "with CRLF line terminators" if it was).
5. **Rerun green**: the filter, then the full suite, before claiming done.

## Pitfalls

- **CRLF files**: `sed` patterns anchored with `$` do not match before `\r`. For multi-line
  mutations use Python with `open(p, encoding="utf-8", newline="")` and replace `\n` with `\r\n` in
  the search strings, so the file keeps its endings.
- **`/tmp` differs between shells** on Windows: Git Bash `/tmp` is not PowerShell's `$env:TEMP`.
  Back up and restore from the same shell, or use an absolute scratch path.
- A mutation that the test does *not* catch means the test is vacuous: fix the test, not the
  mutation. Report this to the user.
- Never leave a mutation in place across a commit; restore before `git add`.
