FROM node:20-slim

WORKDIR /app

COPY gsuite/package*.json ./
RUN npm install

COPY gsuite/ .

RUN npm run build

CMD ["node", "dist/index.js"]
