FROM node:22-alpine
RUN apk add --no-cache git tzdata
WORKDIR /app
COPY package.json collect.mjs ./
COPY lib ./lib
COPY shops ./shops
ENV DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8790
CMD ["node", "collect.mjs"]
