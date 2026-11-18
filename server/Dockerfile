# The web chrome (server/web, TypeScript + React) is bundled first so a deploy never ships a
# stale static/dist — the committed bundle only keeps `cargo run` working without node.
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
COPY scripts ./scripts
# the headless editor (web/domains/pcb/mcp) bundles the editor's schematic and board tool modules
COPY static/sch-tools.js static/pcb-tools.js ./static/
# the Python runtime for KiCad's own plugins packs its pcbnew and wx modules (plugins/python) beside the interpreter
COPY plugins/python ./plugins/python
# the Python harness (harness/kicad_harness) is bundled into the program that runs run_python scripts
COPY harness/kicad_harness ./harness/kicad_harness
# the ngspice WebAssembly engine (vendor/ngspice) is built ahead of time and packed into the Python runtime's ngspice.mjs
COPY vendor ./vendor
RUN npm run check && npm run build

FROM rust:1-slim-bookworm AS build
WORKDIR /app
COPY . .
COPY --from=web /web/static/dist ./static/dist
RUN cargo build --release && cp target/release/kicad-collab-server /srv-bin

# Ubuntu 24.04, the system the desktop's Linux build targets: its kicad-cli converts designs from other EDA tools
# (EasyEDA, Altium, Eagle, ...) uploaded to the web (src/nonkicad_import.rs).  The binaries above are built on
# Debian 12, whose glibc is older, so they run here unchanged.
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl poppler-utils \
    && rm -rf /var/lib/apt/lists/*
# The newest Junction desktop release for Linux and the Ubuntu packages it lists; JUNCTION_RELEASE pins a tag
# (v2.2.0), and an image without it still builds and serves everything but the import.
ARG JUNCTION_RELEASE=latest
# The releases feed is fetched on every build, so a new release invalidates the cached layer below and the next
# deploy installs it
ADD https://github.com/JunctionEDA/junction/releases.atom /tmp/junction-releases.atom
RUN tag="$JUNCTION_RELEASE"; \
    if [ "$tag" = latest ]; then \
      tag=$(curl -fsSI https://github.com/JunctionEDA/junction/releases/latest | tr -d '\r' | sed -n 's#^[Ll]ocation: .*/tag/##p'); \
    fi; \
    rm -f /tmp/junction-releases.atom; \
    if [ -n "$tag" ] && curl -fsSL "https://github.com/JunctionEDA/junction/releases/download/$tag/Junction-${tag#v}-linux-x64.tar.gz" -o /tmp/junction.tgz; then \
      mkdir -p /opt/junction && tar -C /opt/junction -xzf /tmp/junction.tgz && rm /tmp/junction.tgz \
      && apt-get update && xargs -a /opt/junction/usr/share/junction/ubuntu-packages.txt apt-get install -y --no-install-recommends \
      && rm -rf /var/lib/apt/lists/* \
      && printf '#!/bin/sh\nexec /opt/junction/usr/bin/junction kicad-cli "$@"\n' > /opt/junction/kicad-cli && chmod +x /opt/junction/kicad-cli \
      && /opt/junction/kicad-cli version \
      || { echo "Junction $tag could not be installed; importing other tools' designs is off"; rm -rf /opt/junction; }; \
    else echo "no Junction Linux release found; importing other tools' designs is off"; fi
# node runs the headless editor behind the MCP endpoint (src/mcp_host.rs); the Debian build runs on Ubuntu 24.04 too
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=build /srv-bin /usr/local/bin/kicad-collab-server
# served as /static/pyodide/*; too large to compile into the binary (src/pcm.rs runtime_dir)
COPY --from=web /web/static/dist/pyodide /usr/local/share/kicad-collab/pyodide
CMD ["kicad-collab-server"]
