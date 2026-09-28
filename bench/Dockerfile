# The corpus: 22 public MCP servers at fixed versions, for measuring toolmenu's
# rules on real menus. Third-party code: build and run it only in this container.
# See bench/README.md.
FROM node:22-bookworm
RUN apt-get update -qq && apt-get install -y -qq python3-pip > /dev/null && rm -rf /var/lib/apt/lists/*
RUN pip install -q --break-system-packages mcp-atlassian==0.23.1
RUN curl -fsSL https://github.com/github/github-mcp-server/releases/download/v1.12.2/github-mcp-server_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin github-mcp-server
RUN mkdir -p /opt/s && cd /opt/s && npm init -y > /dev/null && npm i --ignore-scripts --no-audit --no-fund \
  @aashari/mcp-server-atlassian-jira@3.3.0 \
  @apify/actors-mcp-server@0.16.0 \
  @brave/brave-search-mcp-server@2.1.4 \
  @browserbasehq/mcp-server-browserbase@2.4.3 \
  @hubspot/mcp-server@0.4.0 \
  @k-jarzyna/mcp-miro@1.0.11 \
  @modelcontextprotocol/server-everything@2026.8.31 \
  @modelcontextprotocol/server-github@2025.4.8 \
  @notionhq/notion-mcp-server@2.5.2 \
  @playwright/mcp@0.0.82 \
  @sentry/mcp-server@0.42.0 \
  @supabase/mcp-server-supabase@0.13.0 \
  @upstash/context7-mcp@4.1.1 \
  chrome-devtools-mcp@1.10.1 \
  exa-mcp-server@3.4.1 \
  figma-developer-mcp@0.13.2 \
  firecrawl-mcp@3.25.5 \
  mongodb-mcp-server@3.0.4 \
  tavily-mcp@0.2.22
ENV PATH="/opt/s/node_modules/.bin:$PATH"
WORKDIR /out
