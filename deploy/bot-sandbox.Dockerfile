# Persistent Bot Cloud-Computer Sandbox Image (Phase 3)
# Build: docker build -f deploy/bot-sandbox.Dockerfile -t superagent/bot-sandbox:latest .
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    python3 \
    python3-pip \
    chromium \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Non-root persistent bot user; `/home/bot` is mounted as a per-bot named volume.
RUN useradd -m -s /bin/bash -u 1001 bot \
    && mkdir -p /home/bot/.browser-profile /workspace \
    && chown -R bot:bot /home/bot /workspace

ENV HOME=/home/bot \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

USER bot
WORKDIR /workspace

# Container stays alive for `docker exec` turns; idle hibernation stops it cleanly
# while preserving the `/home/bot` named volume.
# V2 extension: enable xvfb + x11vnc + websockify for interactive noVNC takeover.
CMD ["sleep", "infinity"]
