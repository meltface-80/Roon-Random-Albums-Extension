FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y git tar python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN mkdir -p /app/data/cache

VOLUME /app/data

EXPOSE 3399

ENV PORT=3399
ENV DOCKER=1

CMD ["npm","start"]
