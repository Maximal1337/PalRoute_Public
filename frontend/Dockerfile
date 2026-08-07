# PalRoute UI: static files served by nginx. No Node in the final image.
#
# Build:  docker build -t palroute-ui ./frontend
# Run:    docker run -p 8080:80 \
#           -e API_BASE=https://api.example.com palroute-ui

FROM nginx:alpine

COPY pages   /usr/share/nginx/html/pages
COPY css     /usr/share/nginx/html/css
COPY scripts /usr/share/nginx/html/scripts
COPY data    /usr/share/nginx/html/data

COPY nginx.conf /etc/nginx/conf.d/default.conf

# Rewrites config.js and the API proxy config at container start.
COPY docker-entrypoint.sh /docker-entrypoint.d/40-palroute-config.sh
RUN chmod +x /docker-entrypoint.d/40-palroute-config.sh

EXPOSE 80
