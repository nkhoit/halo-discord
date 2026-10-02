# The relay and game server. The game build (build/web) and the maps are
# mounted at run time and never baked into the image.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY client ./client
COPY icons ./icons
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8090 BUILD_DIR=/data/build MAPS_DIR=/data/maps
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/main.ts"]
