FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git bash ca-certificates curl ripgrep python3 python3-pip python3-venv default-jdk-headless maven golang-go procps && rm -rf /var/lib/apt/lists/*
COPY app /opt/dsh
COPY entry.mjs runtime-activity.mjs check-cwd.mjs credential-helper.mjs /opt/chainweaver/
COPY --from=ghcr.io/jdx/mise:2026.10.4 /usr/local/bin/mise /usr/local/bin/mise
COPY project-toolchain.mjs /opt/chainweaver/
ENV NODE_ENV=production
WORKDIR /tmp
EXPOSE 3080
ENTRYPOINT ["node","/opt/chainweaver/entry.mjs"]
