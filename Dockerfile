FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
# The database lives on a persistent volume mounted at /data
ENV DATA_DIR=/data
ENV PORT=3040
EXPOSE 3040
CMD ["node", "server.js"]
