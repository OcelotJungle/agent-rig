# JS/TS code conventions

Apply in every JS/TS project, unasked; do not add linters or formatters to enforce them unless asked. In a project
clearly not the user's with a different established convention, follow that project on that one point only.

1. File and directory names are kebab-case only: `rich-out.ts`, `fake-telegram.ts`. Never camelCase, PascalCase or
   snake_case.
2. No code smells: no `any`, no type assertions (`as`, `<T>x`, non-null `!`; only `as const` is allowed), no `enum`,
   no `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`. Narrow with type guards, validate untrusted data with a schema,
   use a union of literals instead of an enum.
3. Magic numbers go into named constants at the top of the file, right after the imports.
4. Type imports and value imports are separate statements: `import type { A } from 'x'` and `import { b } from 'x'`.
   Never mix them as `import { b, type A } from 'x'`.
5. All type imports come first, then one blank line, then all value imports. The two groups never interleave.
6. Strings use double quotes. Single quotes only where they are simpler, such as a string that contains double quotes.
7. Statements end with semicolons. Do not rely on automatic semicolon insertion.
8. Keep the core pure and pass dependencies as arguments; return a Result instead of throwing; `type` for values,
   `interface` only for classes; no arbitrary limits without a domain reason.
9. Load data in batches: no N+1 queries (one query per item in a loop); load once per pass and reuse.
