FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /opt/nexia
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN chmod -R a+rX /opt/nexia && mkdir -p /workspace /home/node/.config/nexia && chown -R node:node /workspace /home/node/.config
USER node
WORKDIR /workspace
EXPOSE 4310
ENTRYPOINT ["node", "/opt/nexia/src/cli.js"]
CMD ["dev", ".", "--container"]
