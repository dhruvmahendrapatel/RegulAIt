FROM node:22-alpine
WORKDIR /srv
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
# Supplied at run time; never baked into the image.
ENV ANTHROPIC_API_KEY=""
CMD ["node", "src/summarise.js"]
