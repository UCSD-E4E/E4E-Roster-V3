FROM node:20-slim

WORKDIR /app

COPY slackbot/package*.json ./
RUN npm install

COPY slackbot/ .

RUN npm run build

CMD ["node", "dist/index.js"]
