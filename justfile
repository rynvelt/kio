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

# Build all publishable packages (emits dist/ per package for npm consumers)
build:
    @for pkg in shared client server react transport-ws transport-bun-ws; do \
        echo "→ build @kiojs/$pkg"; \
        cd {{root_dir}}/packages/$pkg && rm -rf dist && bunx tsgo -p tsconfig.build.json || exit 1; \
    done

# Remove all dist/ output
clean-dist:
    @find packages -maxdepth 2 -type d -name dist -prune -exec rm -rf {} +

# Run linter and formatter checks
check:
    @bunx biome check .

# Fix all auto-fixable issues
fix:
    @bunx biome check --write .

# Run tests
test:
    @bun test

# Start docs dev server
docs-dev:
    @cd {{root_dir}}/apps/kio-docs && bunx astro dev

# Build docs
docs-build:
    @cd {{root_dir}}/apps/kio-docs && bunx astro build
