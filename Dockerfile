FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the "prepare" build runs below, once sources are present.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The HTTP server binds to 127.0.0.1 by default; in a container it must
# listen on all interfaces (publish the port and terminate TLS in front).
# The port is left unset so MCP_HTTP_PORT (or a platform-injected PORT) works.
ENV MCP_HTTP_HOST=0.0.0.0
EXPOSE 3000

USER node
HEALTHCHECK --interval=30s --timeout=3s \
    CMD node -e "const p=process.env.MCP_HTTP_PORT||process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/http-main.js"]
