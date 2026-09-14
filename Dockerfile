# POMPUI VTracer webapp — self-contained multi-stage build.
# Upstream core: https://github.com/visioncortex/vtracer
#
# 1) Compile the standalone VTracer webapp crate to wasm.
# 2) Bundle the browser frontend with webpack.
# 3) Serve the static app with unprivileged nginx on port 8080.

FROM rust:1-alpine AS wasm
RUN apk add --no-cache musl-dev wget
RUN wget -qO- https://rustwasm.github.io/wasm-pack/installer/init.sh | sh

WORKDIR /webapp
COPY webapp/Cargo.toml webapp/Cargo.lock* ./
COPY webapp/src ./src
RUN wasm-pack build --release --target bundler

FROM node:22-alpine AS bundle
WORKDIR /webapp
COPY --from=wasm /webapp/pkg ./pkg
COPY webapp/app/package.json webapp/app/package-lock.json* ./app/
COPY webapp/app/webpack.config.js \
     webapp/app/bootstrap.js \
     webapp/app/index.js \
     webapp/app/color-lab.js \
     webapp/app/index.html \
     webapp/app/pompui-vtracer.css \
     ./app/
COPY docs/assets ./app/assets

WORKDIR /webapp/app
RUN npm ci --ignore-scripts || npm install --ignore-scripts; \
    npx webpack --mode production

FROM nginxinc/nginx-unprivileged:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=bundle /webapp/app/dist /usr/share/nginx/html/
COPY --from=bundle /webapp/app/index.html /usr/share/nginx/html/
COPY --from=bundle /webapp/app/pompui-vtracer.css /usr/share/nginx/html/
COPY html/404.html /usr/share/nginx/html/404.html
COPY docs/assets /usr/share/nginx/html/assets/

EXPOSE 8080
