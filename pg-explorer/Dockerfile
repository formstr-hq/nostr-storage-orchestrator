FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --silent
COPY proxy.mjs index.html ./
USER node
EXPOSE 8090
CMD ["node", "proxy.mjs"]
