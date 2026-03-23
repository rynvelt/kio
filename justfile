# Default recipe - show available commands with descriptions
default:
    @just --list --unsorted

root_dir := justfile_directory()

# Run TypeScript type checking on all packages using tsgo
typecheck:
    @cd {{root_dir}} && bunx tsgo -b tsconfig.all.json

# Clean TypeScript compiler cache (tsbuildinfo files)
clean-ts:
    @find . -path '*/node_modules/.tmp/tsconfig.tsbuildinfo' -delete 2>/dev/null || true

# Run linter and formatter checks
check:
    @bunx biome check .

# Fix all auto-fixable issues
fix:
    @bunx biome check --write .

# Run tests
test:
    @bun test
