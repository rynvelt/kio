# CLAUDE.md

## Commands

- Type checking: `just typecheck`
- Lint & format check: `just check`
- Lint & format fix: `just fix`
- Run tests: `just test`
- Install dependencies: `bun install`

## Hard Rules

- Never use `any`. Avoid `object` and `unknown`.
- Never install dependencies without asking.
- Use `just typecheck` for type checking, never `tsc`.
- Use `bun test` for tests, not `jest` or `vitest`.
- Run `just fix` before suggesting a commit.
