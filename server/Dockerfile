FROM node:22-alpine AS dependencies
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY server/package.json ./package.json
COPY server/index.js server/db.js ./
USER node
EXPOSE 3001
CMD ["node", "index.js"]
