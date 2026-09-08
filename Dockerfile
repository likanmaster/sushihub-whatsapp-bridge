FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3001
ENV AUTH_DIR=/app/auth_info_baileys

EXPOSE 3001

CMD ["node", "index.js"]
