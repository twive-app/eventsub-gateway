# syntax=docker/dockerfile:1
# EventSub Gateway – production image: one compiled executable on distroless,
# no shell, no package manager, no sources.

# Exactly the Bun version of package.json "engines" – bump both together.
ARG BUN_VERSION=1.4.4

# ================================
# Stage 1: Build
# Runs on the build host ($BUILDPLATFORM) and cross-compiles for the target, so multi-arch builds need no QEMU.
# ================================
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine AS build

WORKDIR /build

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun run typecheck

# Version shown on startup and in GET /health: the publish workflow passes the release tag (or <last tag>-dev.<sha>),
# local builds keep the placeholder 0.0.0 of package.json.
ARG VERSION
RUN if [ -n "$VERSION" ]; then bun pm pkg set version="$VERSION"; fi

# No --minify-identifiers: bean tokens are class names. --sourcemap is embedded into the executable, so stack traces
# (and the ErrorReporter location) point to src/. --bytecode fails for this bundle (import.meta in dependencies).
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64) target=bun-linux-x64-baseline ;; \
        arm64) target=bun-linux-arm64 ;; \
        *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && bun build src/index.ts --compile --target="$target" --minify-whitespace --minify-syntax --sourcemap \
        --outfile /build/gateway

# ================================
# Stage 2: Runtime
# glibc (matches the bun-linux-* targets), libstdc++, CA certificates and tzdata – nothing else.
# ================================
FROM gcr.io/distroless/cc-debian13:nonroot AS final

ARG VERSION
ARG REVISION

# Defaults for local builds – the publish workflow overrides them with docker/metadata-action labels.
LABEL org.opencontainers.image.source="https://github.com/twive-app/eventsub-gateway" \
      org.opencontainers.image.title="EventSub Gateway" \
      org.opencontainers.image.vendor="twive.app" \
      org.opencontainers.image.description="A self-hosted gateway that does all the Twitch EventSub work for you and delivers every event to your clients over a single WebSocket connection" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION:-0.0.0}" \
      org.opencontainers.image.revision="${REVISION}"

WORKDIR /app
COPY --from=build /build/gateway /app/gateway

ENV TZ=UTC

USER nonroot
EXPOSE 3000 3001
STOPSIGNAL SIGTERM

# `gateway healthcheck` loads only the configuration and asks GET /health of the running gateway (no shell needed).
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD ["/app/gateway", "healthcheck"]

ENTRYPOINT ["/app/gateway"]
