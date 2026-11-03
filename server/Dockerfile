FROM node:24-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server/src ./src
COPY server/scripts ./scripts
ENV DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "src/index.js"]
