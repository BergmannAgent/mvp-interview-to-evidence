FROM node:24.18.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json .npmrc ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/evaluation-studio/package.json apps/evaluation-studio/package.json
COPY apps/interview/package.json apps/interview/package.json
COPY apps/monitoring/package.json apps/monitoring/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/frontend-i18n/package.json packages/frontend-i18n/package.json
RUN npm ci
COPY . .
RUN npm run clean \
 && npm run build --workspace @orgscience/contracts \
 && npm run build --workspace @orgscience/domain \
 && npm run build --workspace @orgscience/api-client \
 && npm run build --workspace @orgscience/design-tokens \
 && npm run build --workspace @orgscience/frontend-i18n \
 && npm run build --workspace @orgscience/backend \
 && npm run build --workspace @orgscience/interview-web \
 && npm run build --workspace @orgscience/monitoring-web \
 && npm run build --workspace @orgscience/evaluation-studio-web

FROM node:24.18.0-alpine AS backend
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY --from=build /app/apps/backend/drizzle ./apps/backend/drizzle
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
COPY --from=build /app/research/instruments/organizational-resilience ./research/instruments/organizational-resilience
COPY --from=build /app/guides/interviewleitfaden-organizational-resilience-9-items.md ./guides/
COPY --from=build /app/guides/interviewleitfaden-organizational-resilience-9-items.en.md ./guides/
CMD ["node", "apps/backend/dist/main.js"]

FROM nginx:1.29.5-alpine AS interview
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/interview/dist /usr/share/nginx/html

FROM nginx:1.29.5-alpine AS monitoring
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/monitoring/dist /usr/share/nginx/html

FROM nginx:1.29.5-alpine AS evaluation-studio
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/evaluation-studio/dist /usr/share/nginx/html
