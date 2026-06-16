FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

RUN git clone https://github.com/formstr-hq/nostream-share.git .

RUN npm install

RUN npm run build

# Copy resources
RUN mkdir -p dist/resources && \
    cp -r resources/* dist/resources/

# Create nostr config directory
RUN mkdir -p dist/.nostr

# Generate settings file
RUN cp dist/resources/default-settings.yaml dist/.nostr/settings.yaml

EXPOSE 8008

CMD ["npm", "start"]