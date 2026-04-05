FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY idl.json ./idl.json
COPY test-idl.json ./test-idl.json
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/idl.json ./idl.json
COPY --from=builder /app/test-idl.json ./test-idl.json

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
