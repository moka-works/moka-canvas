SHELL := /bin/sh
CARGO_MANIFEST := src-tauri/Cargo.toml
MACOS_X86_TARGET := x86_64-apple-darwin
WINDOWS_CROSS_TARGET := x86_64-pc-windows-gnu
HOST ?= 127.0.0.1
PORT ?= 8080
SOURCE ?= artifacts
DEST ?= dist
TAURI_RELEASE_CONFIG := src-tauri/tauri.release.conf.json

# A linked worktree's src-tauri/target symlink is replaced with a directory of
# its own by this script, so parallel worktrees do not share one cargo lock, one
# target/debug/<binary>, or sccache keys built from the path. A worktree also
# gets a metadata directory beside itself, named on the server's command line at
# run time — never in the environment, which sccache hashes. An explicit
# CARGO_TARGET_DIR wins.
WORKTREE_TARGET := $(shell node scripts/checkout.mjs 2>/dev/null)
ifneq ($(WORKTREE_TARGET),)
CARGO_TARGET_DIR ?= $(WORKTREE_TARGET)
export CARGO_TARGET_DIR
endif
WORKTREE_METADATA := $(shell node scripts/checkout.mjs --metadata-dir 2>/dev/null)
WORKTREE_METADATA_FLAG := $(if $(WORKTREE_METADATA),--metadata-dir $(WORKTREE_METADATA))

# sccache, when installed, wraps every cargo invocation in these recipes, and
# SCCACHE_BASEDIR lets all checkouts share cache entries. It does not cache
# incremental compilations, so those are off unless asked for. Without sccache,
# nothing changes. An explicit RUSTC_WRAPPER still wins.
RUSTC_WRAPPER ?= $(shell command -v sccache >/dev/null 2>&1 && echo sccache)
ifneq ($(RUSTC_WRAPPER),)
export RUSTC_WRAPPER
ifeq ($(RUSTC_WRAPPER),sccache)
export SCCACHE_BASEDIR ?= $(CURDIR)
export CARGO_INCREMENTAL ?= 0
endif
endif

.PHONY: help install fonts check check-deps check-boundaries check-version release-check test web-build web-serve tauri-dev cli package-web package-macos package-macos-x86 package-macos-pkg package-windows package-linux cross-package-windows prepare-release set-version clean

.DEFAULT_GOAL := help

# Self-documenting: a target's trailing `##` comment is its help entry, so the
# list cannot drift from the tasks.
help: ## List available targets
	@awk 'BEGIN {FS = ":.*## "; printf "\nUsage: make <target>\n\n"} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-24s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

ifeq (set-version,$(firstword $(MAKECMDGOALS)))
SET_VERSION_ARG := $(word 2,$(MAKECMDGOALS))
ifneq ($(SET_VERSION_ARG),)
$(eval $(SET_VERSION_ARG):;@:)
endif
endif

set-version: ## Sync the version across the four files (make set-version <semver>)
	@test -n "$(SET_VERSION_ARG)" || (printf '%s\n' 'usage: make set-version <semver>  (e.g. make set-version 1.2.3)' >&2; exit 1)
	node scripts/set-version.mjs $(SET_VERSION_ARG)

install: ## Install npm dependencies
	npm ci

# The burn-in faces are not in this history: they are fetched, pinned by hash,
# before anything that compiles the crate (see scripts/fetch-fonts.mjs).
fonts: ## Fetch the clip burn-in faces this checkout lacks
	node scripts/fetch-fonts.mjs

check: web-build check-boundaries fonts ## Run the full pre-commit gate
	npm run format:check
	npm run lint
	npm run typecheck
	npm test
	cargo fmt --manifest-path $(CARGO_MANIFEST) -- --check
	cargo clippy --manifest-path $(CARGO_MANIFEST) --all-targets -- -D warnings
	cargo test --manifest-path $(CARGO_MANIFEST)

# Boundaries that are cheaper to state as a grep than as a test. Each one
# fails the build with the reason, not with a bare non-zero exit.
check-boundaries: ## Verify the enforced architectural boundaries
	@! grep -rn "MetadataStore" src-tauri/src/project src-tauri/src/assets src-tauri/src/workflow || \
		(printf '%s\n' 'project content must not reach into the metadata layer' >&2; exit 1)
	@! grep -rn "recent_registry_path\|recentRegistryPath" src-tauri/src src-tauri/tests src-tauri/resources config src || \
		(printf '%s\n' 'the superseded recent-project registry must stay removed' >&2; exit 1)
	@! grep -rn "sqlx\|sea-query\|sea_orm" src-tauri/Cargo.toml src-tauri/src || \
		(printf '%s\n' 'no database dependency while the file backend is the only one' >&2; exit 1)
	@! grep -rn "json.tmp" src-tauri/src || \
		(printf '%s\n' 'documents must go through the single atomic-write implementation' >&2; exit 1)
	@! git ls-files --error-unmatch config/moka.yaml >/dev/null 2>&1 || \
		(printf '%s\n' 'config/moka.yaml is what one deployment reads and must stay untracked; config/moka.example.yaml is the tracked one' >&2; exit 1)

check-version: ## Verify the version agrees across the four files
	node scripts/check-version.mjs $(if $(TAG),--tag $(TAG),)

release-check: check-version check ## Verify the version, then run the full check

test: fonts ## Run the frontend and Rust test suites
	npm test
	cargo test --manifest-path $(CARGO_MANIFEST)

# npm ci is a documented prerequisite. When it is skipped after a dependency
# change, tsc reports a wall of unresolved-module errors instead of naming the
# out-of-date install; only missing/invalid entries fail, so leftover
# extraneous packages do not block a build.
check-deps: ## Verify the installed npm dependencies are complete
	@problems=$$(npm ls --depth=0 2>&1 | grep -E '^(npm error )?(missing|invalid):' || true); \
	if [ -n "$$problems" ]; then \
		printf '%s\n' "$$problems" >&2; \
		printf '%s\n' 'dependencies are missing or out of date: run `make install` first' >&2; \
		exit 1; \
	fi

web-build: check-deps ## Build the frontend into dist/
	npm run build

web-serve: web-build fonts ## Build and serve the web app (HOST and PORT override the address)
	cargo run --manifest-path $(CARGO_MANIFEST) --bin moka-server -- --static-dir dist --host $(HOST) --port $(PORT) $(WORKTREE_METADATA_FLAG)

tauri-dev: web-build fonts ## Run the desktop shell
	npm run tauri dev

# The CLI is built ahead of every installer: the bundle asks for a sidecar and
# a missing one fails the build long after the expensive compile.
cli: fonts ## Build the moka CLI sidecar
	node scripts/build-cli.mjs

package-web: web-build fonts ## Package the web server build for deployment
	cargo build --release --manifest-path $(CARGO_MANIFEST) --bin moka-server --bin moka
	node scripts/package-web.mjs

package-macos: web-build cli ## Package the macOS DMG and CLI
	@test "$$(uname -s)" = "Darwin" || (printf '%s\n' 'package-macos must run on macOS.' >&2; exit 1)
	npm run tauri build -- --config $(TAURI_RELEASE_CONFIG) --bundles dmg
	node scripts/collect-release.mjs
	node scripts/package-cli.mjs

# The target is named explicitly so one command covers both hosts: Apple
# Silicon cross-compiles the Intel bundle, Intel builds it natively.
package-macos-x86: web-build fonts ## Package the Intel macOS DMG and CLI
	@test "$$(uname -s)" = "Darwin" || (printf '%s\n' 'package-macos-x86 must run on macOS.' >&2; exit 1)
	@rustup target list --installed | grep -q "$(MACOS_X86_TARGET)" || rustup target add $(MACOS_X86_TARGET)
	node scripts/build-cli.mjs --target $(MACOS_X86_TARGET)
	npm run tauri build -- --config $(TAURI_RELEASE_CONFIG) --target $(MACOS_X86_TARGET) --bundles dmg
	node scripts/collect-release.mjs
	node scripts/package-cli.mjs --target $(MACOS_X86_TARGET)

# A DMG cannot run a postinstall; the combined PKG carries the same app and
# links the bundled CLI into /usr/local/bin.
package-macos-pkg: package-macos ## Package the macOS PKG that also links the CLI
	sh scripts/package-macos-pkg.sh

package-windows: web-build cli ## Package the Windows MSI and NSIS installers
	@case "$$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) printf '%s\n' 'package-windows must run on Windows.' >&2; exit 1;; esac
	npm run tauri build -- --config $(TAURI_RELEASE_CONFIG) --bundles msi,nsis
	node scripts/collect-release.mjs
	node scripts/package-cli.mjs

# One invocation per package kind: a single tauri-bundler process asked for two
# or more kinds stalls after its last bundle — CPU pegged, nothing written, no
# child running — while a process asked for exactly one always finishes. Same
# binary and flags either way; only the grouping differs.
package-linux: web-build cli ## Package the Linux deb, rpm and AppImage bundles
	@test "$$(uname -s)" = "Linux" || (printf '%s\n' 'package-linux must run on Linux.' >&2; exit 1)
	npm run tauri build -- --config $(TAURI_RELEASE_CONFIG) --bundles deb
	npm run tauri build -- --config $(TAURI_RELEASE_CONFIG) --bundles rpm
	npm run tauri build -- --config $(TAURI_RELEASE_CONFIG) --bundles appimage
	node scripts/collect-release.mjs
	node scripts/package-cli.mjs

cross-package-windows: web-build fonts ## Cross-package the Windows NSIS installer from macOS
	@test "$$(uname -s)" = "Darwin" || (printf '%s\n' 'cross-package-windows must run on macOS.' >&2; exit 1)
	@command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || (printf '%s\n' 'mingw-w64 is required: brew install mingw-w64' >&2; exit 1)
	@command -v makensis >/dev/null 2>&1 || (printf '%s\n' 'makensis is required: brew install makensis' >&2; exit 1)
	@rustup target list --installed | grep -q "$(WINDOWS_CROSS_TARGET)" || rustup target add $(WINDOWS_CROSS_TARGET)
	LC_ALL=en_US.UTF-8 \
	CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
	CARGO_TARGET_X86_64_PC_WINDOWS_GNU_AR=x86_64-w64-mingw32-ar \
	node scripts/build-cli.mjs --target $(WINDOWS_CROSS_TARGET)
	LC_ALL=en_US.UTF-8 \
	CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
	CARGO_TARGET_X86_64_PC_WINDOWS_GNU_AR=x86_64-w64-mingw32-ar \
	npm run tauri build -- --config $(TAURI_RELEASE_CONFIG) --target $(WINDOWS_CROSS_TARGET) --bundles nsis
	node scripts/collect-release.mjs
	node scripts/package-cli.mjs --target $(WINDOWS_CROSS_TARGET)

prepare-release: ## Collect release artifacts (SOURCE -> DEST)
	node scripts/prepare-release.mjs \
		--source "$(SOURCE)" \
		--dest "$(DEST)" \
		$(if $(VERSION),--version "$(VERSION)",) \
		$(if $(REQUIRE_ALL),--require-all,)

clean: ## Remove build outputs
	rm -rf dist release src-tauri/target node_modules/.tmp
