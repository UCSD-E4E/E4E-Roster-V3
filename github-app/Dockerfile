FROM node:20-slim

WORKDIR /app

COPY github-app/package*.json ./
RUN npm install

COPY github-app/ .

RUN npm run build

CMD ["node", "dist/index.js"]
