FROM node:24-alpine AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci --workspace @fulfilllens/web --include-workspace-root

COPY apps/web ./apps/web
COPY data/samples ./data/samples
RUN npm run build --workspace @fulfilllens/web

FROM nginxinc/nginx-unprivileged:1.28-alpine

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
